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
                                 Also takes a link from other video sites
                                 yt-dlp knows (Vimeo, news sites, ...):
                                 those get a key "x" + 10 hex chars.
  GET /hls/<videoid>/<file>   -> playlist / segment bytes
  GET /nowplaying?u=<stream>  -> {"title": "Artist - Song"} read from a radio
                                 stream's ICY metadata (public hosts only;
                                 cached 15 s per stream)
  Phone remote relay (car <-> phone through the helper):
  POST /remote/new             -> {"room", "code"}  (car opens a room)
  GET  /remote/pair?code=NNNNNN -> {"room"}         (phone joins by code)
  POST /remote/<room>/cmd      phone -> car command (small JSON)
  GET  /remote/<room>/cmds     car long-polls for commands
  POST /remote/<room>/state/<slot>  car -> phone data, in named slots
                               ("now" small and frequent; "lists" large, rare)
  GET  /remote/<room>/state?v= phone long-polls; gets only the slots that
                               changed since version v, plus server time
  GET /iptv?k=<key>&u=<url>   -> IPTV relay (off unless IPTV_KEY and
                                 IPTV_HOSTS are set): fetches a channel
                                 list, HLS playlist or live .ts stream from
                                 the IPTV provider and hands it to the car
                                 with CORS headers over HTTPS. HLS playlists
                                 are rewritten so segments come through the
                                 relay too.

Stdlib only; yt-dlp and ffmpeg are invoked as subprocesses.
Environment:
  PORT        default 8799
  DATA_DIR    default ./data (session cache: one dir per video id)
  YTDLP_BIN   default "yt-dlp" (PATH lookup)
  FFMPEG_BIN  default "ffmpeg"
  IPTV_KEY    secret the player must send to use /iptv (relay off if empty)
  IPTV_HOSTS  comma-separated provider host names the relay may fetch from
              (e.g. "provider.example,cdn.provider.example"); hosts that a
              relayed playlist or redirect points at are trusted for 6 h
  CLIENT_SETS default "web,android,ios;android;ios"
              (';'-separated yt-dlp player_client sets, tried in order
              until one yields media formats - the web client gives the
              richest format list from residential IPs; the android
              client is the one that still answers from many datacenter
              IPs, where web gets a bot-check wall.)
"""
import hashlib
import hmac
import ipaddress
import socket
import json
import os
import secrets
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8799"))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
YTDLP = os.environ.get("YTDLP_BIN", "yt-dlp")
FFMPEG = os.environ.get("FFMPEG_BIN", "ffmpeg")
CLIENT_SETS = [s.strip() for s in os.environ.get(
    "CLIENT_SETS", "web,android,ios;android;ios").split(";") if s.strip()]
MAX_HEIGHT = 720
HLS_TIME = os.environ.get("HLS_TIME", "2")   # short segments = faster first frame
INFO_TTL = 3 * 3600                          # YouTube media URLs stay valid ~6 h
PREFETCH_TOP = int(os.environ.get("PREFETCH_TOP", "6"))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"

IPTV_KEY = os.environ.get("IPTV_KEY", "")
IPTV_HOSTS = {h.strip().lower() for h in os.environ.get("IPTV_HOSTS", "").split(",") if h.strip()}
_DYN_HOSTS = {}
_DYN_LOCK = threading.Lock()

SESSIONS = {}
SESSIONS_LOCK = threading.Lock()
_INFO = {}                         # vid -> (time, info, clients)
_INFO_LOCK = threading.Lock()
_INFO_INFLIGHT = {}                # vid -> threading.Event (lookup running)
_PREFETCH_SEM = threading.Semaphore(2)  # keep the NAS responsive


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


# Links from sites other than YouTube: key -> URL.
_SITE_URLS = {}
_SITE_LOCK = threading.Lock()


def public_host(host):
    """True if every address the host resolves to is a public one
    (so a pasted link can't make the helper fetch things on the home network)."""
    try:
        addrs = {a[4][0] for a in socket.getaddrinfo(host, None)}
    except OSError:
        return False
    if not addrs:
        return False
    for a in addrs:
        ip = ipaddress.ip_address(a.split("%")[0])
        if not ip.is_global:
            return False
    return True


def site_key_from(raw):
    """A key for a link from another video site, or None."""
    raw = (raw or "").strip()
    u = urllib.parse.urlparse(raw)
    if u.scheme not in ("http", "https") or not u.hostname or len(raw) > 2000:
        return None
    if not public_host(u.hostname):
        return None
    key = "x" + hashlib.sha1(raw.encode()).hexdigest()[:10]
    with _SITE_LOCK:
        _SITE_URLS[key] = raw
        if len(_SITE_URLS) > 500:
            for k in list(_SITE_URLS)[:200]:
                _SITE_URLS.pop(k, None)
    return key


_NP = {}
_NP_LOCK = threading.Lock()


def now_playing(url):
    """The song a radio stream is playing right now, from its ICY metadata."""
    with _NP_LOCK:
        hit = _NP.get(url)
        if hit and time.time() - hit[0] < 15:
            return hit[1]
    title = ""
    req = urllib.request.Request(url, headers={"Icy-MetaData": "1", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=8) as r:
        metaint = int(r.headers.get("icy-metaint") or 0)
        if metaint and metaint < 600000:
            r.read(metaint)
            n = r.read(1)
            if n:
                meta = r.read(n[0] * 16).rstrip(b"\0").decode("utf-8", "replace")
                m = re.search(r"StreamTitle='(.*?)';", meta, re.S)
                if m:
                    title = m.group(1).strip()
    with _NP_LOCK:
        _NP[url] = (time.time(), title)
        if len(_NP) > 300:
            for k in sorted(_NP, key=lambda k: _NP[k][0])[:100]:
                _NP.pop(k, None)
    return title


def cached_info(vid):
    """yt-dlp lookup with a cache shared by /stream and search prefetch.
    If a lookup for the same video is already running (e.g. the prefetch
    that a search started), wait for it instead of starting a second one."""
    while True:
        with _INFO_LOCK:
            hit = _INFO.get(vid)
            if hit and time.time() - hit[0] < INFO_TTL:
                return hit[1], hit[2]
            ev = _INFO_INFLIGHT.get(vid)
            if ev is None:
                ev = threading.Event()
                _INFO_INFLIGHT[vid] = ev
                mine = True
            else:
                mine = False
        if not mine:
            ev.wait(130)
            with _INFO_LOCK:
                hit = _INFO.get(vid)
            if hit:
                return hit[1], hit[2]
            continue  # the other lookup failed; try ourselves
        try:
            info, clients = run_ytdlp_info(vid)
            with _INFO_LOCK:
                _INFO[vid] = (time.time(), info, clients)
                if len(_INFO) > 300:
                    for k in sorted(_INFO, key=lambda k: _INFO[k][0])[:100]:
                        _INFO.pop(k, None)
            return info, clients
        finally:
            with _INFO_LOCK:
                _INFO_INFLIGHT.pop(vid, None)
            ev.set()


def prefetch(vids):
    """Look up the first few search results in the background, so a tap
    on one of them can start converting immediately."""
    def one(v):
        with _PREFETCH_SEM:
            try:
                cached_info(v)
            except Exception as e:
                log("prefetch %s failed: %s" % (v, e))
    for v in vids:
        with _INFO_LOCK:
            fresh = v in _INFO and time.time() - _INFO[v][0] < INFO_TTL
        if not fresh:
            threading.Thread(target=one, args=(v,), daemon=True).start()


def run_ytdlp_info(vid):
    """Try each client set until one yields media formats.
    Returns (info_dict, clients_used) or raises RuntimeError with the
    last yt-dlp error tail."""
    with _SITE_LOCK:
        site_url = _SITE_URLS.get(vid)
    url = site_url or "https://www.youtube.com/watch?v=" + vid
    last_err = ""
    for clients in (["site"] if site_url else CLIENT_SETS):
        cmd = [YTDLP, "-j", "--no-warnings", "--no-playlist", url] if site_url else \
              [YTDLP, "-j", "--no-warnings", "--no-playlist",
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


def run_search(q, n):
    """YouTube search via yt-dlp (ytsearch), flat playlist.
    Returns a list of {id, title, channel, duration, thumb} or raises
    RuntimeError with the last yt-dlp error tail."""
    last_err = ""
    for clients in CLIENT_SETS:
        cmd = [YTDLP, "-J", "--flat-playlist", "--no-warnings",
               "--extractor-args", "youtube:player_client=" + clients,
               "ytsearch%d:%s" % (n, q)]
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            last_err = "yt-dlp search timed out (clients=%s)" % clients
            continue
        if p.returncode != 0:
            tail = (p.stderr or "").strip().splitlines()
            last_err = tail[-1] if tail else "yt-dlp exit %d" % p.returncode
            log("search clients=%s failed: %s" % (clients, last_err))
            continue
        try:
            data = json.loads(p.stdout)
        except ValueError:
            last_err = "yt-dlp search returned unparseable output (clients=%s)" % clients
            continue
        out = []
        for e in data.get("entries", []):
            vid = e.get("id") or ""
            if not re.fullmatch(r"[A-Za-z0-9_-]{11}", vid):
                continue
            thumb = ""
            thumbs = e.get("thumbnails") or []
            for t in thumbs:
                if 200 <= (t.get("width") or 0) <= 640 and t.get("url"):
                    thumb = t["url"]
                    break
            if not thumb and thumbs:
                thumb = thumbs[-1].get("url", "")
            if not thumb:
                thumb = "https://i.ytimg.com/vi/%s/mqdefault.jpg" % vid
            out.append({"id": vid,
                        "title": e.get("title") or "(untitled)",
                        "channel": e.get("channel") or e.get("uploader") or "",
                        "duration": e.get("duration"),
                        "thumb": thumb})
        if out:
            return out
        last_err = "clients=%s search yielded no usable results" % clients
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
        # Other sites often don't say which codecs a format uses. Take the
        # best one that isn't audio-only (or the page's own media URL) and
        # convert it.
        unknown = [f for f in fmts if not is_audio_only(f) and (f.get("height") or 0) <= MAX_HEIGHT] or \
                  [f for f in fmts if not is_audio_only(f)]
        unknown.sort(key=lambda f: (height(f), rate(f)))
        src = unknown[-1] if unknown else (info if info.get("url") else None)
        if src is None:
            raise RuntimeError("no usable video format found")
        return [src["url"]], ["libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
                              "-vf", r"scale=-2:min(720\,ih)"], ["aac", "-b:a", "160k"], \
            "format %s (codecs unknown) TRANSCODE to h264 + aac" % src.get("format_id", "direct")
    plans.sort(key=lambda p: p[0], reverse=True)
    _, inputs, vargs, aargs, desc = plans[0]
    return inputs, vargs, aargs, desc


def input_headers(info, url):
    """Extra request headers (Referer, cookies) a site wants for a media URL."""
    for f in info.get("formats", []) + [info]:
        if f.get("url") == url and f.get("http_headers"):
            h = {k: v for k, v in f["http_headers"].items() if k.lower() != "user-agent"}
            return "".join("%s: %s\r\n" % (k, v) for k, v in h.items())
    return ""


def session_complete(s):
    try:
        with open(os.path.join(s["dir"], "index.m3u8"), "rb") as fh:
            return b"EXT-X-ENDLIST" in fh.read()
    except OSError:
        return False


def start_session(vid):
    with SESSIONS_LOCK:
        s = SESSIONS.get(vid)
        if s and (s["proc"].poll() is None or s["proc"].returncode == 0 or session_complete(s)):
            pass  # handled below, under the lock
        else:
            s = None
    if s is None:
        cached_info(vid)  # slow part, done without blocking other videos
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
        info, clients = cached_info(vid)
        inputs, vargs, aargs, desc = pick_plan(info)
        cmd = [FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "warning"]
        for u in inputs:
            hdrs = input_headers(info, u)
            cmd += ["-user_agent", UA] + (["-headers", hdrs] if hdrs else []) + ["-i", u]
        cmd += ["-map", "0:v:0", "-map", "1:a:0" if len(inputs) > 1 else "0:a:0?",
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
    """Wait until the playlist lists its first segment, or ffmpeg exits."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        pl = os.path.join(s["dir"], "index.m3u8")
        if os.path.exists(pl):
            segs = [f for f in os.listdir(s["dir"]) if f.endswith(".ts")]
            if len(segs) >= 2 or (segs and b"#EXTINF" in open(pl, "rb").read()):
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


# ---------------- IPTV relay ----------------

def iptv_host_ok(url):
    p = urllib.parse.urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        return False
    host = p.hostname.lower()
    if host in IPTV_HOSTS:
        return True
    with _DYN_LOCK:
        exp = _DYN_HOSTS.get(host)
    return bool(exp and exp > time.time())


def iptv_trust(url):
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    if host:
        with _DYN_LOCK:
            _DYN_HOSTS[host] = time.time() + 6 * 3600


def relay_path(target):
    return "/iptv?k=%s&u=%s" % (urllib.parse.quote(IPTV_KEY, safe=""), urllib.parse.quote(target, safe=""))


def rewrite_hls(text, base):
    out = []
    for ln in text.splitlines():
        s = ln.strip()
        if s and not s.startswith("#"):
            absu = urllib.parse.urljoin(base, s)
            iptv_trust(absu)
            ln = relay_path(absu)
        elif 'URI="' in s:
            def sub(m):
                absu = urllib.parse.urljoin(base, m.group(1))
                iptv_trust(absu)
                return 'URI="%s"' % relay_path(absu)
            ln = re.sub(r'URI="([^"]+)"', sub, ln)
        out.append(ln)
    return "\n".join(out) + "\n"


# ---------------- phone remote relay ----------------
# A room links one car screen with any phones that joined it. Rooms live
# in memory only, are found by a 128-bit random id, and vanish after
# 8 hours without use. The 6-digit code only works for 15 minutes and
# wrong guesses are rate-limited per address.

ROOMS = {}
ROOMS_LOCK = threading.Lock()
ROOM_IDLE = 8 * 3600
CODE_TTL = 15 * 60
MAX_PHONES = 3        # phones with the remote open at the same time
PHONE_ACTIVE = 90      # seconds a phone counts as "open" after its last check-in
_PAIR_FAILS = {}  # ip -> [timestamps]


def _gc_rooms():
    now = time.time()
    for rid in [r for r, v in ROOMS.items() if now - v["used"] > ROOM_IDLE]:
        ROOMS.pop(rid, None)


def room_get(rid):
    with ROOMS_LOCK:
        r = ROOMS.get(rid)
        if r:
            r["used"] = time.time()
        return r


def room_new():
    with ROOMS_LOCK:
        _gc_rooms()
        if len(ROOMS) > 200:
            raise RuntimeError("too many open remotes")
        rid = secrets.token_urlsafe(16)
        used_codes = {v["code"] for v in ROOMS.values()}
        code = "%06d" % secrets.randbelow(1000000)
        while code in used_codes:
            code = "%06d" % secrets.randbelow(1000000)
        ROOMS[rid] = {"code": code, "code_at": time.time(), "used": time.time(),
                      "cmds": [], "slots": {}, "ver": 0, "cond": threading.Condition(), "seen": {}}
        return rid, code


def phones_active(r, exclude=""):
    now = time.time()
    return sum(1 for pid, ts in r["seen"].items() if pid != exclude and now - ts < PHONE_ACTIVE)


FULL_MSG = "three phones are already using the remote - try again when one of them closes it"


def room_by_code(code, ip, pid=""):
    now = time.time()
    with ROOMS_LOCK:
        fails = [t for t in _PAIR_FAILS.get(ip, []) if now - t < 3600]
        if len(fails) >= 20:
            return None, "too many wrong codes - try again later"
        for rid, r in ROOMS.items():
            if r["code"] == code and now - r["code_at"] < CODE_TTL:
                if phones_active(r, pid) >= MAX_PHONES:
                    return None, FULL_MSG
                if pid:
                    r["seen"][pid] = now
                r["used"] = now
                return rid, None
        fails.append(now)
        _PAIR_FAILS[ip] = fails
        return None, "that code didn't match - check the code on the car screen"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
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

    def _iptv(self, u):
        qs = urllib.parse.parse_qs(u.query)
        key = qs.get("k", [""])[0]
        target = qs.get("u", [""])[0]
        if not IPTV_KEY or not hmac.compare_digest(key.encode(), IPTV_KEY.encode()):
            return self._json(403, {"error": "IPTV relay is off, or the key is wrong"})
        if not iptv_host_ok(target):
            return self._json(403, {"error": "that host is not in IPTV_HOSTS"})
        req = urllib.request.Request(target, headers={"User-Agent": UA})
        try:
            resp = urllib.request.urlopen(req, timeout=20)
        except urllib.error.HTTPError as e:
            return self._json(502, {"error": "provider answered HTTP %d" % e.code})
        except Exception as e:
            return self._json(502, {"error": "provider unreachable", "detail": str(e)})
        with resp:
            final = resp.geturl()
            iptv_trust(final)  # the provider redirected us there
            ctype = resp.headers.get("Content-Type", "") or ""
            lpath = urllib.parse.urlparse(final).path.lower()
            textual = (lpath.endswith((".m3u8", ".m3u", ".php")) or "mpegurl" in ctype.lower()
                       or "json" in ctype.lower() or ctype.lower().startswith("text/"))
            if textual:
                body = resp.read(64 * 1024 * 1024)
                if b"#EXT-X-" in body[:200000]:
                    body = rewrite_hls(body.decode("utf-8", "replace"), final).encode()
                    ctype = "application/vnd.apple.mpegurl"
                self.send_response(200)
                self.send_header("Content-Type", ctype or "application/octet-stream")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-cache")
                self._cors()
                self.end_headers()
                self.wfile.write(body)
                return
            # Media: a segment (has a length) or an endless live .ts stream.
            length = resp.headers.get("Content-Length")
            self.send_response(200)
            self.send_header("Content-Type", ctype or "video/mp2t")
            self.send_header("Cache-Control", "no-cache")
            self._cors()
            if length:
                self.send_header("Content-Length", length)
                self.end_headers()
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            else:
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                while True:
                    chunk = resp.read1(65536)
                    if not chunk:
                        break
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")

    def _body_json(self, limit):
        raw = self._raw
        if not raw or len(raw) > limit:
            raise ValueError("body missing or too large")
        return json.loads(raw.decode("utf-8"))

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        # Always read the whole body first, even when a route ignores it:
        # leftover bytes on a reused (keep-alive) connection would be read
        # as the start of the next request and break it.
        n = int(self.headers.get("Content-Length") or 0)
        if n > 2500000:
            self.close_connection = True
            return self._json(413, {"error": "request too large"})
        self._raw = self.rfile.read(n) if n > 0 else b""
        try:
            if u.path == "/remote/new":
                try:
                    rid, code = room_new()
                except RuntimeError as e:
                    return self._json(503, {"error": str(e)})
                return self._json(200, {"room": rid, "code": code, "code_ttl": CODE_TTL})
            m = re.match(r"^/remote/([A-Za-z0-9_-]{16,40})/(cmd|state/([a-z]{1,16}))$", u.path)
            if m:
                r = room_get(m.group(1))
                if not r:
                    return self._json(404, {"error": "this remote has expired - pair again"})
                is_cmd = m.group(2) == "cmd"
                try:
                    body = self._body_json(4096 if is_cmd else 2000000)
                except (ValueError, UnicodeDecodeError):
                    return self._json(400, {"error": "bad request body"})
                with r["cond"]:
                    if is_cmd:
                        if not isinstance(body, dict) or not isinstance(body.get("type"), str):
                            return self._json(400, {"error": "bad command"})
                        r["cmds"] = (r["cmds"] + [body])[-50:]
                    else:
                        if len(r["slots"]) >= 8 and m.group(3) not in r["slots"]:
                            return self._json(400, {"error": "too many slots"})
                        r["ver"] += 1
                        r["slots"][m.group(3)] = (r["ver"], body)
                    r["cond"].notify_all()
                return self._json(200, {"ok": True, "ver": r["ver"], "t": time.time() * 1000})
            return self._json(404, {"error": "unknown route"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                self._json(500, {"error": "internal", "detail": str(e)})
            except Exception:
                pass

    def _remote_get(self, u):
        qs = urllib.parse.parse_qs(u.query)
        if u.path == "/remote/pair":
            code = (qs.get("code", [""])[0] or "").strip()
            if not re.fullmatch(r"\d{6}", code):
                return self._json(400, {"error": "enter the 6-digit code from the car screen"})
            pid = (qs.get("p", [""])[0] or "")[:40]
            rid, err = room_by_code(code, self.client_address[0] if not self.headers.get("X-Forwarded-For")
                                    else self.headers["X-Forwarded-For"].split(",")[0].strip(), pid)
            if not rid:
                return self._json(403, {"error": err})
            return self._json(200, {"room": rid})
        m = re.match(r"^/remote/([A-Za-z0-9_-]{16,40})/(cmds|state)$", u.path)
        if not m:
            return self._json(404, {"error": "unknown route"})
        r = room_get(m.group(1))
        if not r:
            return self._json(404, {"error": "this remote has expired - pair again"})
        wait = min(25.0, max(0.0, float(qs.get("wait", ["20"])[0] or 0)))
        deadline = time.time() + wait
        with r["cond"]:
            if m.group(2) == "cmds":
                while not r["cmds"] and time.time() < deadline:
                    r["cond"].wait(max(0.05, deadline - time.time()))
                out, r["cmds"] = r["cmds"], []
                return self._json(200, {"cmds": out, "t": time.time() * 1000})
            have = int(qs.get("v", ["0"])[0] or 0)
            pid = (qs.get("p", [""])[0] or "")[:40]
            if pid:
                fresh = time.time() - r["seen"].get(pid, 0) < PHONE_ACTIVE
                if not fresh and phones_active(r, pid) >= MAX_PHONES:
                    return self._json(409, {"error": FULL_MSG})
                r["seen"][pid] = time.time()
                if len(r["seen"]) > 50:
                    for k in sorted(r["seen"], key=r["seen"].get)[:25]:
                        r["seen"].pop(k, None)
            while r["ver"] <= have and time.time() < deadline:
                r["cond"].wait(max(0.05, deadline - time.time()))
            if pid:
                r["seen"][pid] = time.time()
            changed = {k: v[1] for k, v in r["slots"].items() if v[0] > have}
            return self._json(200, {"ver": r["ver"], "slots": changed, "t": time.time() * 1000})

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
                return self._json(200, {"ok": True, "sites": True,
                                        "yt_dlp": ver([YTDLP, "--version"]),
                                        "ffmpeg": ver([FFMPEG, "-version"])})
            if u.path == "/":
                return self._json(200, {"service": "nate-theater-youtube-helper",
                                        "usage": "/stream?v=<youtube url or video id>",
                                        "search": "/search?q=<terms>&n=<count>"})
            if u.path == "/nowplaying":
                raw = urllib.parse.parse_qs(u.query).get("u", [""])[0]
                p = urllib.parse.urlparse(raw)
                if p.scheme not in ("http", "https") or not p.hostname or not public_host(p.hostname):
                    return self._json(400, {"error": "bad stream address"})
                try:
                    return self._json(200, {"title": now_playing(raw)})
                except Exception as e:
                    return self._json(200, {"title": "", "detail": str(e)[:200]})
            if u.path == "/iptv":
                return self._iptv(u)
            if u.path.startswith("/remote/"):
                return self._remote_get(u)
            if u.path == "/search":
                qs = urllib.parse.parse_qs(u.query)
                q = (qs.get("q", [""])[0] or "").strip()
                if not q:
                    return self._json(400, {"error": "missing q parameter"})
                try:
                    n = max(1, min(24, int(qs.get("n", ["12"])[0])))
                except ValueError:
                    n = 12
                try:
                    results = run_search(q, n)
                except RuntimeError as e:
                    return self._json(502, {"error": "search failed", "detail": str(e)})
                prefetch([r["id"] for r in results[:PREFETCH_TOP]])
                return self._json(200, {"query": q, "results": results})
            if u.path == "/stream":
                qs = urllib.parse.parse_qs(u.query)
                raw = qs.get("v", [""])[0]
                vid = video_id_from(raw) or site_key_from(raw)
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
