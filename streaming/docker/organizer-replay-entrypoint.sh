#!/usr/bin/env bash

set -Eeuo pipefail

FOOTAGE_DIR="${FOOTAGE_DIR:-/demo-footage}"
MEDIAMTX_HOST="${MEDIAMTX_HOST:-mediamtx}"
MEDIAMTX_PORT="${MEDIAMTX_PORT:-8554}"
if [[ ! "${MEDIAMTX_PUBLISH_PASSWORD:-}" =~ ^[a-fA-F0-9]{64}$ ]]; then
  echo "MEDIAMTX_PUBLISH_PASSWORD must be 64 hexadecimal characters" >&2
  exit 1
fi
RETRY_SECONDS="${RETRY_SECONDS:-5}"
[[ "$RETRY_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid retry interval" >&2; exit 1; }

PIDS=()

SOURCES=()
CAMERA_LIMIT="${CAMERA_LIMIT:-30}"
[[ "$CAMERA_LIMIT" =~ ^[1-9][0-9]*$ ]] && (( CAMERA_LIMIT <= 30 )) || { echo "CAMERA_LIMIT must be 1-30" >&2; exit 1; }
for ((n=1; n<=CAMERA_LIMIT; n++)); do
  printf -v id 'cam%02d' "$n"
  SOURCES+=("direct-${id}|${id}.mp4")
done

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

cleanup() {
  trap - EXIT INT TERM
  log "Stopping organizer replay publishers..."

  for pid in "${PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  wait 2>/dev/null || true
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ -d "$FOOTAGE_DIR" ]] || {
  echo "Demo footage directory is unavailable: $FOOTAGE_DIR" >&2
  exit 1
}

log "Waiting for MediaMTX at ${MEDIAMTX_HOST}:${MEDIAMTX_PORT}..."

ready=0

for _ in {1..60}; do
  if timeout 1 bash -c \
    "</dev/tcp/${MEDIAMTX_HOST}/${MEDIAMTX_PORT}" \
    2>/dev/null; then
    ready=1
    break
  fi

  sleep 1
done

(( ready == 1 )) || {
  echo "MediaMTX did not become ready within 60 seconds." >&2
  exit 1
}

publish() (
  local stream_id="$1"
  local filename="$2"
  local input_file="${FOOTAGE_DIR}/${filename}"
  local target="rtsp://publisher:${MEDIAMTX_PUBLISH_PASSWORD}@${MEDIAMTX_HOST}:${MEDIAMTX_PORT}/stream/${stream_id}"
  publisher_pid=""
  stop_publisher() {
    if [[ -n "$publisher_pid" ]]; then
      kill -TERM "$publisher_pid" 2>/dev/null || true
      wait "$publisher_pid" 2>/dev/null || true
    fi
  }
  trap stop_publisher EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  [[ -s "$input_file" ]] || {
    log "[$stream_id] missing or empty file: $input_file"
    return 1
  }

  while true; do
    log "[$stream_id] publishing RECORDED ORGANIZER FOOTAGE ${filename}"

    ffmpeg \
      -nostdin \
      -hide_banner \
      -loglevel quiet \
      -progress "/tmp/${stream_id}.progress" \
      -re \
      -stream_loop -1 \
      -fflags +genpts+discardcorrupt \
      -err_detect ignore_err \
      -i "$input_file" \
      -map 0:v:0 \
      -an \
      -c:v copy \
      -bsf:v h264_mp4toannexb \
      -f rtsp \
      -rtsp_transport tcp \
      "$target" &
    publisher_pid=$!
    wait "$publisher_pid" || true
    publisher_pid=""

    log "[$stream_id] publisher stopped; retrying in ${RETRY_SECONDS}s"
    sleep "$RETRY_SECONDS"
  done
)

for source in "${SOURCES[@]}"; do
  IFS='|' read -r stream_id filename <<< "$source"

  [[ -s "${FOOTAGE_DIR}/${filename}" ]] || {
    echo "Recording is missing: ${FOOTAGE_DIR}/${filename}" >&2
    exit 1
  }

  codec=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=nw=1:nk=1 "${FOOTAGE_DIR}/${filename}")
  [[ "$codec" == h264 ]] || { echo "Unsupported codec for $filename: prepare H.264 first" >&2; exit 1; }
  publish "$stream_id" "$filename" &
  PIDS+=("$!")
done

log "Organizer replay publishers launched: ${#PIDS[@]}"
wait -n || true
log "A demo supervisor exited unexpectedly."
exit 1
