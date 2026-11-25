#!/usr/bin/env python3
"""Check which channels in an M3U list will actually play in Nate's Theater.

Tests each channel the way the car's player would:
  1. the stream address is https (the site is https; http is blocked)
  2. the playlist answers, with CORS headers that let the site read it
  3. it is not encrypted and does not use fMP4 segments
  4. the chosen variant is H.264 (+ AAC) - no HEVC/AV1/AC-3-only audio
  5. a real segment downloads (with CORS) and its MPEG-TS program table
     lists H.264 video (and AAC audio when the audio is muxed in)

Passing channels are written to a JSON file the app reads, e.g.
channels/checked-us.json, so the region tabs show only channels that
worked in the last check (with a "Show all" link for the rest).

Usage (from the repo root):
  python tools/check_channels.py                  # all built-in regions
  python tools/check_channels.py us uk ca         # some regions
  python tools/check_channels.py --m3u URL --name mylist

Do NOT run --m3u on a paid IPTV subscription link and commit the result:
the output keeps each stream address, and those addresses contain your
login. This repo is public.

Stdlib only. A run checks one region's channels in parallel (24 at a
time); the US list (~1,500 channels) takes a few minutes.
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ORIGIN = "https://natesrooms.github.io"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Tesla"
REGIONS = ["us", "ca", "uk", "ie", "au", "nz", "mx", "es", "fr", "de", "it", "nl", "br", "in", "jp", "kr"]
TIMEOUT = 12
MAX_SEG_BYTES = 600_000


class Fail(Exception):
    pass


def fetch(url, limit=None):
    """GET with the site's Origin; returns (final_url, headers, bytes)."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Origin": ORIGIN, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read(limit) if limit else r.read()
            return r.geturl(), r.headers, body
    except urllib.error.HTTPError as e:
        raise Fail("HTTP %d" % e.code)
    except Exception as e:  # DNS, TLS, timeout, reset
        raise Fail("unreachable (%s)" % e.__class__.__name__)


def cors_ok(headers):
    a = (headers.get("Access-Control-Allow-Origin") or "").strip()
    return a == "*" or a == ORIGIN


def attrs(s):
    out = {}
    for m in re.finditer(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)', s):
        v = m.group(2)
        out[m.group(1)] = v[1:-1] if v.startswith('"') else v
    return out


def parse_playlist(text, base):
    pl = {"master": False, "variants": [], "audio": [], "segments": [], "end": False, "enc": False, "map": False}
    pending = None
    for ln in text.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        if ln.startswith("#EXT-X-STREAM-INF:"):
            pl["master"] = True
            pending = attrs(ln[18:])
        elif ln.startswith("#EXT-X-MEDIA:"):
            a = attrs(ln[13:])
            if a.get("TYPE") == "AUDIO" and a.get("URI"):
                pl["audio"].append({"uri": urllib.parse.urljoin(base, a["URI"]), "group": a.get("GROUP-ID", ""), "default": a.get("DEFAULT") == "YES"})
        elif ln.startswith("#EXT-X-KEY:"):
            if attrs(ln[11:]).get("METHOD", "NONE") != "NONE":
                pl["enc"] = True
        elif ln.startswith("#EXT-X-MAP:"):
            pl["map"] = True
        elif ln == "#EXT-X-ENDLIST":
            pl["end"] = True
        elif not ln.startswith("#"):
            uri = urllib.parse.urljoin(base, ln)
            if pending is not None:
                pl["variants"].append({"uri": uri, "bw": int(pending.get("BANDWIDTH", "0") or 0),
                                       "codecs": pending.get("CODECS", "").lower(), "audio": pending.get("AUDIO", "")})
                pending = None
            else:
                pl["segments"].append(uri)
    return pl


def pick_variant(variants):
    """Same choice the player makes: H.264, AAC preferred, <= 2.8 Mbps."""
    vs = [v for v in variants if not v["codecs"] or "avc1" in v["codecs"]] or list(variants)
    aac = [v for v in vs if not v["codecs"] or "mp4a" in v["codecs"]]
    vs = aac or vs
    vs.sort(key=lambda v: v["bw"])
    under = [v for v in vs if 0 < v["bw"] <= 2_800_000]
    return under[-1] if under else (vs[0] if vs else None)


def ts_stream_types(data):
    """Stream types listed in the first PMT of an MPEG-TS chunk, or None."""
    i, n = 0, len(data)
    while i + 376 < n and not (data[i] == 0x47 and data[i + 188] == 0x47):
        i += 1
    pmt_pid = None
    for off in range(i, n - 187, 188):
        p = data[off:off + 188]
        if p[0] != 0x47:
            continue
        pusi = p[1] & 0x40
        pid = ((p[1] & 0x1F) << 8) | p[2]
        afc = (p[3] >> 4) & 3
        if afc in (0, 2):
            continue
        st = 4 + (1 + p[4] if afc == 3 else 0)
        if st >= 188 or not pusi:
            continue
        pl = p[st:]
        pl = pl[1 + pl[0]:]
        if len(pl) < 12:
            continue
        if pid == 0 and pmt_pid is None and pl[0] == 0:
            sl = ((pl[1] & 0x0F) << 8) | pl[2]
            end = min(3 + sl - 4, len(pl))
            for j in range(8, end - 3, 4):
                if (pl[j] << 8) | pl[j + 1]:
                    pmt_pid = ((pl[j + 2] & 0x1F) << 8) | pl[j + 3]
                    break
        elif pmt_pid is not None and pid == pmt_pid and pl[0] == 2:
            sl = ((pl[1] & 0x0F) << 8) | pl[2]
            end = min(3 + sl - 4, len(pl))
            j = 12 + (((pl[10] & 0x0F) << 8) | pl[11])
            types = set()
            while j + 5 <= end:
                types.add(pl[j])
                j += 5 + (((pl[j + 3] & 0x0F) << 8) | pl[j + 4])
            return types
    return None


def check_ts(data, need_audio):
    types = ts_stream_types(data)
    if types is None:
        raise Fail("segment is not MPEG-TS")
    if 0x24 in types:
        raise Fail("HEVC video")
    if 0x1B not in types:
        raise Fail("no H.264 video")
    if need_audio and 0x0F not in types:
        raise Fail("audio is not AAC")


def media_playlist(url):
    final, hd, body = fetch(url, 4_000_000)
    if not cors_ok(hd):
        raise Fail("blocks web players (no CORS)")
    text = body.decode("utf-8", "replace")
    if "#EXTM3U" not in text[:1024]:
        raise Fail("not an HLS playlist")
    return parse_playlist(text, final)


def check_channel(url):
    if not url.lower().startswith("https://"):
        raise Fail("http:// only")
    path = urllib.parse.urlparse(url).path.lower()
    if path.endswith(".mpd"):
        raise Fail("DASH, not HLS")
    if path.endswith(".ts"):
        final, hd, body = fetch(url, MAX_SEG_BYTES)
        if not cors_ok(hd):
            raise Fail("blocks web players (no CORS)")
        check_ts(body, True)
        return
    pl = media_playlist(url)
    if pl["enc"]:
        raise Fail("encrypted")
    if pl["map"]:
        raise Fail("fMP4 segments")
    audio_separate = False
    if pl["master"]:
        v = pick_variant(pl["variants"])
        if not v:
            raise Fail("no variants")
        if v["codecs"] and "avc1" not in v["codecs"]:
            raise Fail("not H.264 (%s)" % v["codecs"])
        if v["audio"]:
            rend = [a for a in pl["audio"] if a["group"] == v["audio"]]
            if rend:
                audio_separate = True
                a = next((x for x in rend if x["default"]), rend[0])
                apl = media_playlist(a["uri"])
                if apl["enc"] or apl["map"]:
                    raise Fail("audio track encrypted/fMP4")
        pl = media_playlist(v["uri"])
        if pl["enc"]:
            raise Fail("encrypted")
        if pl["map"]:
            raise Fail("fMP4 segments")
    if not pl["segments"]:
        raise Fail("empty playlist")
    seg = pl["segments"][-3] if (not pl["end"] and len(pl["segments"]) >= 3) else pl["segments"][0]
    final, hd, body = fetch(seg, MAX_SEG_BYTES)
    if not cors_ok(hd):
        raise Fail("segments block web players (no CORS)")
    check_ts(body, not audio_separate)


def parse_m3u(text):
    out, cur = [], None
    for raw in text.splitlines():
        ln = raw.strip()
        if not ln:
            continue
        if ln.startswith("#EXTINF"):
            def attr(k):
                m = re.search(k + r'="([^"]*)"', ln)
                return m.group(1) if m else ""
            name = ln[ln.rfind(",") + 1:].strip() if "," in ln else "Channel"
            cur = {"name": name, "logo": attr("tvg-logo"), "cat": (attr("group-title") or "Other").split(";")[0]}
        elif not ln.startswith("#"):
            if cur is not None:
                cur["url"] = ln
                if not cur["logo"].startswith("https://"):
                    cur["logo"] = ""
                out.append(cur)
            cur = None
    return out


def run(source_url, out_path, workers):
    print("Fetching %s" % source_url, flush=True)
    _, _, body = fetch(source_url)
    chans = parse_m3u(body.decode("utf-8", "replace"))
    # one entry per stream address
    seen, uniq = set(), []
    for c in chans:
        if c["url"] not in seen:
            seen.add(c["url"])
            uniq.append(c)
    total = len(uniq)
    print("  %d channels; checking with %d at a time..." % (total, workers), flush=True)
    passed, reasons = [], {}

    def one(c):
        try:
            check_channel(c["url"])
            return c, None
        except Fail as e:
            return c, str(e)
        except Exception as e:  # parser surprises count as failures, not crashes
            return c, "error (%s)" % e.__class__.__name__

    done = 0
    with cf.ThreadPoolExecutor(max_workers=workers) as pool:
        for c, why in pool.map(one, uniq):
            done += 1
            if why is None:
                passed.append(c)
            else:
                key = re.sub(r"\(.*\)", "", why).strip() if why.startswith(("unreachable", "error")) else why
                reasons[key] = reasons.get(key, 0) + 1
            if done % 100 == 0:
                print("  %d/%d checked, %d passing" % (done, total, len(passed)), flush=True)
    order = {c["url"]: i for i, c in enumerate(uniq)}
    passed.sort(key=lambda c: order[c["url"]])
    result = {
        "source": source_url,
        "checked": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "total": total, "ok": len(passed),
        "why_failed": dict(sorted(reasons.items(), key=lambda kv: -kv[1])),
        "channels": [{"name": c["name"], "cat": c["cat"], "url": c["url"], "logo": c["logo"]} for c in passed],
    }
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)
    print("  %d of %d passed -> %s" % (len(passed), total, out_path), flush=True)
    for k, v in list(result["why_failed"].items())[:8]:
        print("     %5d  %s" % (v, k))
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("regions", nargs="*", help="region codes (default: all built-in regions)")
    ap.add_argument("--m3u", help="check this M3U list instead of iptv-org regions")
    ap.add_argument("--name", default="custom", help="output name for --m3u (channels/checked-NAME.json)")
    ap.add_argument("--out-dir", default="channels")
    ap.add_argument("--workers", type=int, default=24)
    a = ap.parse_args()
    if a.m3u:
        run(a.m3u, os.path.join(a.out_dir, "checked-%s.json" % a.name), a.workers)
        return
    for cc in (a.regions or REGIONS):
        try:
            run("https://iptv-org.github.io/iptv/countries/%s.m3u" % cc,
                os.path.join(a.out_dir, "checked-%s.json" % cc), a.workers)
        except Fail as e:
            print("  %s: could not fetch the list (%s)" % (cc, e), file=sys.stderr)


if __name__ == "__main__":
    main()
