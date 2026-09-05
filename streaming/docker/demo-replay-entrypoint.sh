#!/usr/bin/env bash

set -Eeuo pipefail

FOOTAGE_DIR="${FOOTAGE_DIR:-/demo-footage}"
MEDIAMTX_HOST="${MEDIAMTX_HOST:-mediamtx}"
MEDIAMTX_PORT="${MEDIAMTX_PORT:-8554}"
RETRY_SECONDS="${RETRY_SECONDS:-5}"

PIDS=()

SOURCES=(
  "demo-cam67|67_MOTA BAZAR.AVI"
  "demo-cam88|88_RAGHUVEER CIRCLE.AVI"
  "demo-cam142|142_TOWNHALL.AVI"
  "demo-cam161|161_APC CIRCLE.AVI"
  "demo-cam180|180_SAMARKHA CHOKDI.AVI"
  "demo-railway-exit|RAILWAY STATION EXIT.AVI"
)

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

cleanup() {
  trap - EXIT INT TERM
  log "Stopping demo-footage publishers..."

  for pid in "${PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  wait 2>/dev/null || true
}

trap cleanup EXIT INT TERM

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

publish() {
  local stream_id="$1"
  local filename="$2"
  local input_file="${FOOTAGE_DIR}/${filename}"
  local target="rtsp://${MEDIAMTX_HOST}:${MEDIAMTX_PORT}/stream/${stream_id}"

  [[ -s "$input_file" ]] || {
    log "[$stream_id] missing or empty file: $input_file"
    return 1
  }

  while true; do
    log "[$stream_id] publishing ${filename}"

    ffmpeg \
      -nostdin \
      -hide_banner \
      -loglevel warning \
      -re \
      -stream_loop -1 \
      -fflags +genpts+discardcorrupt \
      -err_detect ignore_err \
      -i "$input_file" \
      -map 0:v:0 \
      -an \
      -vf "scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:black,fps=15" \
      -c:v libx264 \
      -preset ultrafast \
      -tune zerolatency \
      -b:v 900k \
      -maxrate 1100k \
      -bufsize 1800k \
      -pix_fmt yuv420p \
      -g 30 \
      -keyint_min 30 \
      -sc_threshold 0 \
      -threads 1 \
      -f rtsp \
      -rtsp_transport tcp \
      "$target" || true

    log "[$stream_id] publisher stopped; retrying in ${RETRY_SECONDS}s"
    sleep "$RETRY_SECONDS"
  done
}

for source in "${SOURCES[@]}"; do
  IFS='|' read -r stream_id filename <<< "$source"

  [[ -s "${FOOTAGE_DIR}/${filename}" ]] || {
    echo "Required recording is missing: ${FOOTAGE_DIR}/${filename}" >&2
    exit 1
  }

  publish "$stream_id" "$filename" &
  PIDS+=("$!")
done

log "Demo-footage publishers launched: ${#PIDS[@]}"
wait
