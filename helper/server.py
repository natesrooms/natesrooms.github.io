#!/usr/bin/env python3
"""Nate's Theater - YouTube helper service.

Accepts a YouTube video URL/ID, extracts the media server-side with
yt-dlp, and serves the WebCodecs canvas player a compliant HLS stream:
MPEG-TS segments, H.264 video + AAC audio (the only codecs the player
decodes). Prefers sources that are already H.264/AAC so ffmpeg can
REMUX (stream copy); transcodes only when no H.264 source exists
(video capped at 720p).

Endpoints:
  GET /health                 -> {"ok": true, "yt_dlp": ..., "ffmpeg": ...}
  GET /stream?v=<url-or-id>   -> the HLS playlist itself (segments
                                 referenced by absolute /hls/... paths);
                                 starts the ffmpeg job on first hit and
                                 serves the growing EVENT playlist on
                                 every poll thereafter
  GET /hls/<videoid>/<file>   -> playlist / segment bytes

Stdlib only; yt-dlp and ffmpeg are invoked as subprocesses.
Environment:
  PORT        default 8799
  DATA_DIR    default ./data (session cache: one dir per video id)
  YTDLP_BIN   default "yt-dlp" (PATH lookup)
  FFMPEG_BIN  default "ffmpeg"
  CLIENT_SETS default "web,android,ios;android;ios"
              (';'-separated yt-dlp player_client sets, tried in order
              until one yields media formats - the web client gives the
              richest format list from residential IPs; the android
              client is the one that still answers from many datacenter
              IPs, where web gets a bot-check wall.)
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8799"))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
YTDLP = os.environ.get("YTDLP_BIN", "yt-dlp")
FFMPEG = os.environ.get("FFMPEG_BIN", "ffmpeg")
CLIENT_SETS = [s.strip() for s in os.environ.get(
    "CLIENT_SETS", "web,android,ios;android;ios").split(";") if s.strip()]
MAX_HEIGHT = 720
HLS_TIME = "6"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"

SESSIONS = {}
SESSIONS_LOCK = threading.Lock()


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def video_id_from(raw):
    raw = (raw or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", raw):
        return raw
    u = urllib.parse.urlparse(raw)
    if u.hostname and "youtu.be" in u.hostname:
        cand = u.path.lstrip("/").split("/")[0]
        if re.fullmatch(r"[A-Za-z0-9_-]{11}", cand):
            return cand
    qs = urllib.parse.parse_qs(u.query)
    if "v" in qs and re.fullmatch(r"[A-Za-z0-9_-]{11}", qs["v"][0]):
        return qs["v"][0]
    m = re.search(r"(?:shorts|embed|live)/([A-Za-z0-9_-]{11})", u.path or "")
    if m:
        return m.group(1)
    return None


def run_ytdlp_info(vid):
    """Try each client set until one yields media formats.
    Returns (info_dict, clients_used) or raises RuntimeError with the
    last yt-dlp error tail."""
    url = "https://www.youtube.com/watch?v=" + vid
    last_err = ""
    for clients in CLIENT_SETS:
        cmd = [YTDLP, "-j", "--no-warnings", "--no-playlist",
               "--extractor-args", "youtube:player_client=" + clients, url]
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        except subprocess.TimeoutExpired:
            last_err = "yt-dlp timed out (clients=%s)" % clients
            continue
        if p.returncode != 0:
            tail = (p.stderr or "").strip().splitlines()
            last_err = tail[-1] if tail else "yt-dlp exit %d" % p.returncode
            log("clients=%s failed: %s" % (clients, last_err))
            continue
        try:
            info = json.loads(p.stdout)
        except ValueError:
            last_err = "yt-dlp returned unparseable output (clients=%s)" % clients
            continue
        media = [f for f in info.get("formats", [])
                 if f.get("url") and not str(f.get("format_id", "")).startswith("sb")
                 and (f.get("vcodec") not in (None, "none") or f.get("acodec") not in (None, "none"))]
        if media:
            return info, clients
        last_err = "clients=%s yielded no media formats (storyboards only)" % clients
        log(last_err)
    raise RuntimeError(last_err)


def pick_plan(info):
    """Choose (inputs, vcodec_args, acodec_args, description).
    inputs: list of media URLs (1 = combined or video-only, 2 = video+audio).
    Prefers the tallest H.264 <= 720p; stream-copy wherever possible."""
    fmts = [f for f in info.get("formats", [])
            if f.get("url") and not str(f.get("format_id", "")).startswith("sb")]

    def is_video(f):
        return f.get("vcodec") not in (None, "none")

    def is_audio_only(f):
        return f.get("vcodec") in (None, "none") and f.get("acodec") not in (None, "none")

    def is_avc(f):
        return str(f.get("vcodec") or "").startswith("avc1")

    def is_mp4a(f):
        return str(f.get("acodec") or "").startswith("mp4a")

    def height(f):
        return f.get("height") or 0

    def rate(f):
        return f.get("tbr") or f.get("abr") or 0

    videos = [f for f in fmts if is_video(f) and height(f) <= MAX_HEIGHT] or \
             [f for f in fmts if is_video(f)]
    audios = sorted([f for f in fmts if is_audio_only(f)],
                    key=lambda f: (is_mp4a(f), rate(f)), reverse=True)
    best_audio = audios[0] if audios else None

    plans = []  # (sort_key, inputs, vargs, aargs, desc)
    for v in videos:
        combined = v.get("acodec") not in (None, "none")
        if is_avc(v):
            if combined and is_mp4a(v):
                plans.append(((height(v), 3), [v["url"]], ["copy"], ["copy"],
                              "combined %s %sp avc+mp4a remux" % (v["format_id"], height(v))))
            elif best_audio is not None:
                aargs = ["copy"] if is_mp4a(best_audio) else ["aac", "-b:a", "160k"]
                plans.append(((height(v), 3 if is_mp4a(best_audio) else 2),
                              [v["url"], best_audio["url"]], ["copy"], aargs,
                              "video %s %sp avc remux + audio %s (%s)" % (
                                  v["format_id"], height(v), best_audio["format_id"],
                                  "copy" if is_mp4a(best_audio) else "opus->aac")))
        else:
            if combined or best_audio is not None:
                inputs = [v["url"]] if combined else [v["url"], best_audio["url"]]
                aargs = ["copy"] if (combined and is_mp4a(v)) or \
                        (best_audio is not None and is_mp4a(best_audio)) else ["aac", "-b:a", "160k"]
                plans.append(((height(v), 0), inputs,
                              ["libx264", "-preset", "veryfast", "-crf", "20",
                               "-pix_fmt", "yuv420p", "-vf", r"scale=-2:min(720\,ih)"],
                              aargs,
                              "video %s %sp %s TRANSCODE to h264 + audio (%s)" % (
                                  v["format_id"], height(v), v.get("vcodec"),
                                  "copy" if aargs == ["copy"] else "aac")))
    if not plans:
        raise RuntimeError("no usable video format found")
    plans.sort(key=lambda p: p[0], reverse=True)
    _, inputs, vargs, aargs, desc = plans[0]
    return inputs, vargs, aargs, desc


def session_complete(s):
    try:
        with open(os.path.join(s["dir"], "index.m3u8"), "rb") as fh:
            return b"EXT-X-ENDLIST" in fh.read()
    except OSError:
        return False


def start_session(vid):
    with SESSIONS_LOCK:
        s = SESSIONS.get(vid)
        if s:
            if s["proc"].poll() is None:
                return s  # conversion still running
            if s["proc"].returncode == 0 or session_complete(s):
                s["done_ok"] = True
                return s  # finished conversion is cached on disk; reuse it
            # ffmpeg died without finishing: fall through and retry fresh
            log("session %s: previous ffmpeg exited rc=%s, restarting" % (vid, s["proc"].returncode))
        sdir = os.path.join(DATA_DIR, vid)
        os.makedirs(sdir, exist_ok=True)
        for old in os.listdir(sdir):
            try:
                os.remove(os.path.join(sdir, old))
            except OSError:
                pass
        info, clients = run_ytdlp_info(vid)
        inputs, vargs, aargs, desc = pick_plan(info)
        cmd = [FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "warning"]
        for u in inputs:
            cmd += ["-user_agent", UA, "-i", u]
        cmd += ["-map", "0:v:0", "-map", "1:a:0" if len(inputs) > 1 else "0:a:0",
                "-c:v"] + vargs + ["-c:a"] + aargs + [
                "-max_muxing_queue_size", "1024",
                "-f", "hls", "-hls_time", HLS_TIME,
                "-hls_segment_type", "mpegts",
                "-hls_playlist_type", "event",
                "-hls_flags", "independent_segments",
                "-hls_segment_filename", os.path.join(sdir, "seg%05d.ts"),
                os.path.join(sdir, "index.m3u8")]
        errlog = open(os.path.join(sdir, "ffmpeg.log"), "wb")
        proc = subprocess.Popen(cmd, stdout=errlog, stderr=errlog)
        s = {"dir": sdir, "proc": proc, "plan": desc, "clients": clients,
             "title": info.get("title"), "started": time.time(), "done_ok": False}
        SESSIONS[vid] = s
        log("session %s started: %s (clients=%s)" % (vid, desc, clients))
        return s


def wait_ready(s, timeout=90):
    """Wait until the playlist exists with >=2 segments, or ffmpeg exits."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        pl = os.path.join(s["dir"], "index.m3u8")
        if os.path.exists(pl):
            segs = [f for f in os.listdir(s["dir"]) if f.endswith(".ts")]
            if len(segs) >= 2:
                return True
        if s["proc"].poll() is not None:
            segs = [f for f in os.listdir(s["dir"]) if f.endswith(".ts")]
            ok = os.path.exists(pl) and len(segs) >= 1
            s["done_ok"] = ok
            return ok
        time.sleep(0.5)
    return os.path.exists(os.path.join(s["dir"], "index.m3u8"))


def ffmpeg_log_tail(s, n=3000):
    try:
        with open(os.path.join(s["dir"], "ffmpeg.log"), "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - n))
            return fh.read().decode("utf-8", "replace")
    except OSError:
        return ""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        try:
            if u.path == "/health":
                def ver(cmd):
                    try:
                        p = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
                        return (p.stdout or p.stderr).strip().splitlines()[0]
                    except Exception as e:
                        return "unavailable: %s" % e
                return self._json(200, {"ok": True,
                                        "yt_dlp": ver([YTDLP, "--version"]),
                                        "ffmpeg": ver([FFMPEG, "-version"])})
            if u.path == "/":
                return self._json(200, {"service": "nate-theater-youtube-helper",
                                        "usage": "/stream?v=<youtube url or video id>"})
            if u.path == "/stream":
                qs = urllib.parse.parse_qs(u.query)
                vid = video_id_from(qs.get("v", [""])[0])
                if not vid:
                    return self._json(400, {"error": "missing or unparseable v parameter"})
                try:
                    s = start_session(vid)
                except RuntimeError as e:
                    return self._json(502, {"error": "extraction failed", "detail": str(e)})
                if not wait_ready(s):
                    return self._json(502, {"error": "ffmpeg produced no segments",
                                            "detail": ffmpeg_log_tail(s)})
                # Serve the playlist AT this URL with segment references
                # rewritten to absolute paths. (The player resolves
                # relative segment URLs against the directory of the URL
                # it was given - the origin root here - so a 302 to the
                # real playlist location would strand the segments.)
                with open(os.path.join(s["dir"], "index.m3u8"), "r") as fh:
                    lines = fh.read().splitlines()
                out = []
                for ln in lines:
                    if ln and not ln.startswith("#") and not ln.startswith("/") and "://" not in ln:
                        ln = "/hls/%s/%s" % (vid, ln)
                    out.append(ln)
                body = ("\n".join(out) + "\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-cache")
                self._cors()
                self.end_headers()
                self.wfile.write(body)
                return
            m = re.match(r"^/hls/([A-Za-z0-9_-]{11})/([A-Za-z0-9_.-]+)$", u.path)
            if m:
                vid, name = m.group(1), m.group(2)
                if ".." in name:
                    return self._json(400, {"error": "bad path"})
                path = os.path.join(DATA_DIR, vid, name)
                if not os.path.isfile(path):
                    return self._json(404, {"error": "not found"})
                ctype = "application/vnd.apple.mpegurl" if name.endswith(".m3u8") else "video/mp2t"
                with open(path, "rb") as fh:
                    body = fh.read()
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                if name.endswith(".m3u8"):
                    self.send_header("Cache-Control", "no-cache")
                self._cors()
                self.end_headers()
                self.wfile.write(body)
                return
            return self._json(404, {"error": "unknown route"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                self._json(500, {"error": "internal", "detail": str(e)})
            except Exception:
                pass


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log("listening on :%d (data=%s)" % (PORT, DATA_DIR))
    srv.serve_forever()


if __name__ == "__main__":
    main()
