#!/usr/bin/env bash

set -u

INPUT_URL="${NETRA_PHONE_INPUT_URL:-rtsp://127.0.0.1:8554/ingest/pruthil-phone}"
OUTPUT_URL="${NETRA_PHONE_OUTPUT_URL:-rtsp://127.0.0.1:8554/stream/pruthil-phone}"
RETRY_SECONDS="${NETRA_PHONE_RETRY_SECONDS:-5}"

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
[[ "$RETRY_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid retry interval" >&2; exit 1; }
[[ "$INPUT_URL" != "$OUTPUT_URL" ]] || { echo "Input and output must differ" >&2; exit 1; }

while true; do
  echo "Starting phone camera relay."

  ffmpeg -hide_banner -loglevel warning -nostdin \
    -rtsp_transport tcp \
    -timeout 15000000 \
    -fflags nobuffer -flags low_delay \
    -i "$INPUT_URL" \
    -map 0:v:0 -an \
    -vf "fps=15" \
    -c:v libx264 -pix_fmt yuv420p \
    -preset ultrafast -tune zerolatency \
    -g 15 -keyint_min 15 \
    -force_key_frames 'expr:gte(t,n_forced*1)' \
    -sc_threshold 0 \
    -b:v 1500k -maxrate 1800k -bufsize 3000k \
    -fps_mode cfr \
    -f rtsp -rtsp_transport tcp \
    "$OUTPUT_URL" &

  ffmpeg_pid=$!
  wait "$ffmpeg_pid"
  ffmpeg_pid=""

  echo "Phone relay disconnected; retrying in ${RETRY_SECONDS}s..." >&2
  sleep "$RETRY_SECONDS"
done
