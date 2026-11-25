#!/bin/sh
# Builds ../player.html from the parts in this folder:
#   part1-head.html   page markup + styles
#   part2-core.html   HLS / MPEG-TS / H.264 / MP4 parsing (opens a <script>)
#   part3-engine.js   WebCodecs + canvas playback engine
#   part4-app.js      pages, Plex, Live TV, YouTube, radio, player UI
cd "$(dirname "$0")"
{
  cat part1-head.html
  cat part2-core.html
  printf '</script>\n<script>\n'
  cat part3-engine.js
  printf '</script>\n<script>\n'
  cat part4-app.js
  printf '</script>\n</body>\n</html>\n'
} > ../player.html
