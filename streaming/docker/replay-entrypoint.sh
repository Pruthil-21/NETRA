#!/usr/bin/env bash
set -Eeuo pipefail

ARCHIVE_DIR="${ARCHIVE_DIR:-/recordings}"
MEDIAMTX_HOST="${MEDIAMTX_HOST:-mediamtx}"
MEDIAMTX_PORT="${MEDIAMTX_PORT:-8554}"
EDGE_NODE_ID="${EDGE_NODE_ID:-edge-local-001}"
STREAM_PREFIX="${STREAM_PREFIX:-direct}"
CAMERA_LIMIT="${CAMERA_LIMIT:-30}"
TRANSCODE_CAMERAS="${TRANSCODE_CAMERAS:-^(cam15|cam27|cam29|cam30)$}"

PIDS=()

cleanup() {
  trap - EXIT INT TERM

  echo
  echo "Stopping recorded-feed publishers..."

  for pid in "${PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  wait 2>/dev/null || true
}

trap cleanup EXIT INT TERM

if [[ ! "$CAMERA_LIMIT" =~ ^[0-9]+$ ]] ||
   (( CAMERA_LIMIT < 1 )); then
  echo "CAMERA_LIMIT must be a positive integer." >&2
  exit 1
fi

if [[ ! "$EDGE_NODE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "EDGE_NODE_ID contains unsupported characters: $EDGE_NODE_ID" >&2
  exit 1
fi

if [[ ! -d "$ARCHIVE_DIR" ]]; then
  echo "Recording directory is unavailable: $ARCHIVE_DIR" >&2
  exit 1
fi

echo "Edge node: $EDGE_NODE_ID"
echo "Camera limit: $CAMERA_LIMIT"
echo "Waiting for MediaMTX at $MEDIAMTX_HOST:$MEDIAMTX_PORT..."
mediamtx_ready=0

for _ in {1..60}; do
  if timeout 1 bash -c \
    "</dev/tcp/$MEDIAMTX_HOST/$MEDIAMTX_PORT" \
    2>/dev/null; then
    mediamtx_ready=1
    break
  fi

  sleep 1
done

if (( mediamtx_ready == 0 )); then
  echo "MediaMTX did not become ready within 60 seconds." >&2
  exit 1
fi

stream_file() {
  local input_file="$1"
  local camera_id
  local target_url

  camera_id="$(basename "$input_file" .mp4)"
  target_url="rtsp://${MEDIAMTX_HOST}:${MEDIAMTX_PORT}/stream/${STREAM_PREFIX}-${camera_id}"

  while true; do
    echo "[$camera_id] publishing to $target_url"

    if [[ "$camera_id" =~ $TRANSCODE_CAMERAS ]]; then
      ffmpeg -nostdin -hide_banner -loglevel warning \
        -re -stream_loop -1 -fflags +genpts \
        -i "$input_file" -map 0:v:0 -an \
        -vf "fps=20" \
        -c:v libx264 -preset veryfast -tune zerolatency \
        -b:v 2500k -maxrate 3000k -bufsize 5000k \
        -pix_fmt yuv420p -g 20 -keyint_min 20 \
        -sc_threshold 0 -threads 2 \
        -f rtsp -rtsp_transport tcp "$target_url"
    else
      ffmpeg -nostdin -hide_banner -loglevel warning \
        -re -stream_loop -1 -fflags +genpts \
        -i "$input_file" -map 0:v:0 -an \
        -c:v copy \
        -f rtsp -rtsp_transport tcp "$target_url"
    fi

    echo "[$camera_id] publisher stopped; retrying in 5 seconds"
    sleep 5
  done
}

mapfile -t FILES < <(
  find "$ARCHIVE_DIR" \
    -maxdepth 1 \
    -type f \
    -name 'cam*.mp4' \
    -print |
  sort |
  sed -n "1,${CAMERA_LIMIT}p"
)

if (( ${#FILES[@]} == 0 )); then
  echo "No cam*.mp4 recordings were found in $ARCHIVE_DIR." >&2
  exit 1
fi

for input_file in "${FILES[@]}"; do
  stream_file "$input_file" &
  PIDS+=("$!")
done

echo "Recorded publishers launched: ${#PIDS[@]}"
wait
