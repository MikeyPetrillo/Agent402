#!/usr/bin/env bash
# A402-06 / CVE-2026-8461 (FFmpeg MagicYUV heap overflow) verification.
#
# Run this INSIDE the deployed container (Railway shell) or against a locally
# built image. It records the ffmpeg build and whether the vulnerable MagicYUV
# decoder is even compiled in, so the live image is auditable without guessing.
#
# Context: every ffmpeg and ffprobe call (src/tools/media-kit.js) passes an
# audio-only `-codec_whitelist` before `-i`, so no video decoder opens, MagicYUV
# included. `-vn` alone was not enough: probing an input decodes a frame of each
# stream before any output option applies (scripts/test-ffmpeg-novideo.js runs
# real ffmpeg against a video input). Pin/patch anyway; do NOT run a real exploit
# file to "prove" reachability.
set -euo pipefail

echo "== ffmpeg version =="
ffmpeg -version 2>/dev/null | head -2 || { echo "ffmpeg not found on PATH"; exit 2; }

echo
echo "== libavcodec (where the MagicYUV decoder lives) =="
dpkg-query -W -f='${Package} ${Version}\n' ffmpeg 'libavcodec*' 2>/dev/null || echo "(dpkg unavailable — not a Debian image?)"

echo
echo "== MagicYUV decoder present in this build? =="
if ffmpeg -hide_banner -decoders 2>/dev/null | grep -qi magicyuv; then
  echo "PRESENT — CVE-2026-8461 applies IF this libavcodec predates the fixed"
  echo "branch. Confirm the version against the Debian security tracker"
  echo "(https://security-tracker.debian.org/tracker/CVE-2026-8461), upgrade the"
  echo "package, or rebuild ffmpeg with: --disable-decoder=magicyuv"
  STATUS=1
else
  echo "ABSENT — the vulnerable decoder is not compiled in; not exploitable via"
  echo "MagicYUV in this image."
  STATUS=0
fi

echo
echo "== recorded at build time (/app/.ffmpeg-version) =="
cat /app/.ffmpeg-version 2>/dev/null || echo "(not found — image predates the recording step)"

exit "${STATUS:-0}"
