#!/usr/bin/env bash
set -u

ARCHIVE_DIR="${ARCHIVE_DIR:-$HOME/Downloads/NETRA-organizer-archive}"
MEDIAMTX_HOST="${MEDIAMTX_HOST:-127.0.0.1}"
LOG_DIR="$ARCHIVE_DIR/logs/replay"

PIDS=()

mkdir -p "$LOG_DIR"

cleanup() {
  echo
  echo "Stopping downloaded-feed streams..."

  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done

  wait 2>/dev/null || true
}

trap cleanup EXIT INT TERM

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1"
    exit 1
  fi
}

stream_file() {
  input_file="$1"
  camera_id=$(basename "$input_file" .mp4)
  target_url="rtsp://$MEDIAMTX_HOST:8554/stream/organizer-$camera_id"
  log_file="$LOG_DIR/$camera_id.log"

  while true; do
    echo "[$camera_id] looping to $target_url"

    if [[ "$camera_id" =~ ^(cam15|cam27|cam29|cam30)$ ]]; then
  ffmpeg -nostdin -hide_banner -loglevel warning \
    -re \
    -stream_loop -1 \
    -fflags +genpts \
    -i "$input_file" \
    -map 0:v:0 \
    -an \
    -vf "fps=20" \
    -c:v h264_videotoolbox \
    -b:v 2500k \
    -pix_fmt yuv420p \
    -g 20 \
    -force_key_frames 'expr:gte(t,n_forced*1)' \
    -f rtsp \
    -rtsp_transport tcp \
    "$target_url" >>"$log_file" 2>&1
else
  ffmpeg -nostdin -hide_banner -loglevel warning \
    -re \
    -stream_loop -1 \
    -fflags +genpts \
    -i "$input_file" \
    -map 0:v:0 \
    -an \
    -c:v copy \
    -f rtsp \
    -rtsp_transport tcp \
    "$target_url" >>"$log_file" 2>&1
fi

    echo "[$camera_id] publisher stopped; retrying in 5 seconds" >>"$log_file"
    sleep 5
  done
}

require_command ffmpeg
require_command ffprobe
require_command lsof

if ! lsof -nP -iTCP:8554 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "MediaMTX is not listening on port 8554."
  echo "Start MediaMTX first, then rerun this script."
  exit 1
fi

if [[ ! -d "$ARCHIVE_DIR" ]]; then
  echo "Archive folder does not exist:"
  echo "  $ARCHIVE_DIR"
  exit 1
fi

FILES=()

if (( $# > 0 )); then
  for camera_id in "$@"; do
    input_file="$ARCHIVE_DIR/$camera_id.mp4"

    if [[ -f "$input_file" ]]; then
      FILES+=("$input_file")
    else
      echo "Skipping missing file: $input_file"
    fi
  done
else
  while IFS= read -r input_file; do
    FILES+=("$input_file")
  done < <(
    find "$ARCHIVE_DIR" \
      -maxdepth 1 \
      -type f \
      -name 'cam*.mp4' \
      -print |
    sort
  )
fi

if (( ${#FILES[@]} == 0 )); then
  echo "No completed camera archives were found."
  echo "Expected files such as:"
  echo "  $ARCHIVE_DIR/cam01.mp4"
  exit 1
fi

valid_count=0

for input_file in "${FILES[@]}"; do
  if ffprobe -v error \
    -select_streams v:0 \
    -show_entries stream=codec_name \
    -of csv=p=0 \
    "$input_file" >/dev/null 2>&1; then

    stream_file "$input_file" &
    PIDS+=("$!")
    valid_count=$((valid_count + 1))
  else
    echo "Skipping invalid video: $input_file"
  fi
done

echo
echo "Downloaded-feed publishers launched: $valid_count"
echo
echo "RTSP pattern:"
echo "  rtsp://$MEDIAMTX_HOST:8554/stream/organizer-cam01"
echo
echo "HLS pattern:"
echo "  http://$MEDIAMTX_HOST:8888/stream/organizer-cam01/index.m3u8"
echo
echo "Press Control+C to stop all streams."

for pid in "${PIDS[@]}"; do
  wait "$pid" 2>/dev/null || true
done
