#!/bin/sh
# Builds the site from the parts in this folder:
#   part1-head.html   page markup + styles
#   part2-core.html   HLS / MPEG-TS / H.264 / MP4 parsing (opens a <script>)
#   part3-engine.js   WebCodecs + canvas playback engine
#   part5-qr.js       small QR code generator (phone-remote pairing)
#   part4-app.js      pages, Plex, Live TV, YouTube, radio, remote, player UI
# Output: ../index.html (the app, served at the site root) and
#         ../player.html (forwards old links to the root, keeping #/page).
cd "$(dirname "$0")"
{
  cat part1-head.html
  cat part2-core.html
  printf '</script>\n<script>\n'
  cat part3-engine.js
  printf '</script>\n<script>\n'
  cat part5-qr.js
  printf '</script>\n<script>\n'
  cat part4-app.js
  printf '</script>\n</body>\n</html>\n'
} > ../index.html
cat > ../player.html <<'EOF'
<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nate's Theater</title><link rel="icon" href="data:," />
<script>location.replace('./' + location.search + location.hash);</script>
<meta http-equiv="refresh" content="0; url=./" />
</head><body style="background:#0c0d10;color:#f3f3f1;font-family:sans-serif;text-align:center;padding:56px 20px">
<p>Nate&rsquo;s Theater has moved to <a href="./" style="color:#f2545b">the site&rsquo;s main address</a>.</p>
</body></html>
EOF
