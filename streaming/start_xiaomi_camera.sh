#!/usr/bin/env bash

set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

INPUT_URL="${NETRA_XIAOMI_INPUT_URL:-rtsp://127.0.0.1:8555/xiaomi-camera}"
OUTPUT_URL="${NETRA_XIAOMI_OUTPUT_URL:-rtsp://127.0.0.1:8554/stream/xiaomi-camera}"
RETRY_SECONDS="${NETRA_XIAOMI_RETRY_SECONDS:-5}"

ffmpeg_pid=""

cleanup() {
  local status=$?

  trap - EXIT INT TERM

  if [[ -n "$ffmpeg_pid" ]]; then
    kill "$ffmpeg_pid" 2>/dev/null || true
  fi

  wait 2>/dev/null || true
  exit "$status"
}

trap cleanup EXIT INT TERM

command -v ffmpeg >/dev/null 2>&1 || {
  echo "Error: ffmpeg is not installed." >&2
  exit 1
}

while true; do
  echo "Relaying Xiaomi camera: $INPUT_URL -> $OUTPUT_URL"

  ffmpeg -hide_banner -loglevel warning -nostdin \
    -rtsp_transport tcp \
    -fflags nobuffer -flags low_delay \
    -i "$INPUT_URL" \
    -map 0:v:0 -an \
    -c:v libx264 -pix_fmt yuv420p \
    -preset ultrafast -tune zerolatency \
    -r 20 -g 20 -keyint_min 20 \
    -force_key_frames 'expr:gte(t,n_forced*1)' \
    -sc_threshold 0 \
    -b:v 2500k -maxrate 3000k -bufsize 3000k \
    -f rtsp -rtsp_transport tcp \
    "$OUTPUT_URL" &

  ffmpeg_pid=$!
  wait "$ffmpeg_pid"
  ffmpeg_pid=""

  echo "Xiaomi relay disconnected; retrying in ${RETRY_SECONDS}s..." >&2
  sleep "$RETRY_SECONDS"
done
