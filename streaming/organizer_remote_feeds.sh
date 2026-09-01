#!/usr/bin/env bash
set -u

PORTAL_URL="${PORTAL_URL:-https://cctv.corp8.cloud}"
MEDIAMTX_HOST="${MEDIAMTX_HOST:-127.0.0.1}"
ARCHIVE_DIR="${ARCHIVE_DIR:-$HOME/Downloads/NETRA-organizer-archive}"
DOWNLOAD_JOBS="${DOWNLOAD_JOBS:-3}"
DOWNLOAD_DURATION="${DOWNLOAD_DURATION:-1800}"

STREAM_PREFIX="${STREAM_PREFIX:-direct}"

RUNTIME_DIR="${TMPDIR:-/tmp}/netra-organizer-$$"
COOKIE_JAR="$RUNTIME_DIR/cookies.txt"
CAMERA_MANIFEST="$RUNTIME_DIR/cameras.json"
LOG_DIR="$ARCHIVE_DIR/logs"

PIDS=()

mkdir -p "$RUNTIME_DIR" "$ARCHIVE_DIR" "$LOG_DIR"

cleanup() {
  echo
  echo "Stopping direct organizer feed processes..."
  pkill -TERM -f "ffmpeg.*rtsp://127.0.0.1:8554/stream/${STREAM_PREFIX}-cam" 2>/dev/null || true

  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done

  wait 2>/dev/null || true
  rm -rf "$RUNTIME_DIR"
}

trap cleanup EXIT INT TERM

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1"
    exit 1
  fi
}

authenticate() {
  echo "Authenticating with the organizer portal..."

  curl -LsS \
    -c "$COOKIE_JAR" \
    -o /dev/null \
    "$PORTAL_URL/"

  if [ -z "${ORGANIZER_PASSWORD:-}" ]; then
    read -r -s -p "Organizer password: " portal_password
    echo
  else
    portal_password="$ORGANIZER_PASSWORD"
  fi

  curl -LsS \
    -b "$COOKIE_JAR" \
    -c "$COOKIE_JAR" \
    --data-urlencode "password=$portal_password" \
    -o /dev/null \
    "$PORTAL_URL/auth/login"

  unset portal_password

  if ! curl -LfsS \
    -b "$COOKIE_JAR" \
    -c "$COOKIE_JAR" \
    -o "$CAMERA_MANIFEST" \
    "$PORTAL_URL/cameras.json"; then
    echo "Authentication failed or camera manifest is unavailable."
    exit 1
  fi

  if ! jq -e 'type == "array" and length > 0' \
    "$CAMERA_MANIFEST" >/dev/null; then
    echo "The returned camera manifest is invalid."
    exit 1
  fi

  echo "Authenticated cameras: $(jq 'length' "$CAMERA_MANIFEST")"
}

build_cookie_header() {
  awk -F $'\t' '
    NF >= 7 {
      if (cookies != "") cookies = cookies "; "
      cookies = cookies $6 "=" $7
    }
    END { print cookies }
  ' "$COOKIE_JAR"
}

relay_camera() {
  camera_id="$1"
  cookie_header="$2"
  source_url="$PORTAL_URL/$camera_id/index.m3u8"
  target_url="rtsp://$MEDIAMTX_HOST:8554/stream/${STREAM_PREFIX}-$camera_id"
  log_file="$LOG_DIR/relay-${STREAM_PREFIX}-$camera_id.log"

  while true; do
    echo "[$camera_id] publishing to $target_url"

    ffmpeg -nostdin -hide_banner -loglevel warning \
      -re \
      -user_agent "Mozilla/5.0" \
      -headers "Cookie: $cookie_header"$'\r\n'"Referer: $PORTAL_URL/"$'\r\n' \
      -i "$source_url" \
      -map 0:v:0 \
      -an \
      -vf "scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:black,fps=15" \
      -c:v h264_videotoolbox \
      -b:v 1000k \
      -maxrate 1200k \
      -bufsize 2000k \
      -pix_fmt yuv420p \
      -g 30 \
      -fps_mode cfr \
      -f rtsp \
      -rtsp_transport tcp \
      "$target_url" >>"$log_file" 2>&1

    echo "[$camera_id] disconnected; retrying in 5 seconds" >>"$log_file"
    sleep 5
  done
}

stream_remote() {
  if ! lsof -nP -iTCP:8554 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "MediaMTX is not listening on port 8554."
    echo "Start MediaMTX first, then rerun this command."
    exit 1
  fi

  cookie_header=$(build_cookie_header)

  while IFS= read -r camera_id; do
    relay_camera "$camera_id" "$cookie_header" &
    PIDS+=("$!")
  done < <(jq -r ".[0:${CAMERA_LIMIT:-30}][].id" "$CAMERA_MANIFEST")

  unset cookie_header

  echo
  echo "All ${#PIDS[@]} organizer feeds were launched."
  echo "RTSP pattern:"
  echo "  rtsp://$MEDIAMTX_HOST:8554/stream/${STREAM_PREFIX}-cam01"
  echo
  echo "HLS pattern:"
  echo "  http://$MEDIAMTX_HOST:8888/stream/${STREAM_PREFIX}-cam01/index.m3u8"
  echo
  echo "Press Control+C to stop all relays."

  for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
}

download_camera() {
  camera_id="$1"
  camera_name="$2"
  cookie_header="$3"

  source_url="$PORTAL_URL/$camera_id/index.m3u8"
  output_file="$ARCHIVE_DIR/$camera_id.mp4"
  partial_file="$ARCHIVE_DIR/$camera_id.part.mp4"
  log_file="$LOG_DIR/download-$camera_id.log"

  if [[ -f "$output_file" ]] &&
     ffprobe -v error "$output_file" >/dev/null 2>&1; then
    echo "[$camera_id] already downloaded; skipping"
    return
  fi

  echo "[$camera_id] downloading: $camera_name"
  rm -f "$partial_file"

  if ffmpeg -nostdin -hide_banner -loglevel warning \
    -user_agent "Mozilla/5.0" \
    -headers "Cookie: $cookie_header"$'\r\n'"Referer: $PORTAL_URL/"$'\r\n' \
    -i "$source_url" \
      -t "$DOWNLOAD_DURATION" \
    -map 0:v:0 \
    -an \
    -c:v copy \
    -movflags +faststart \
    "$partial_file" >"$log_file" 2>&1; then

    mv "$partial_file" "$output_file"
    echo "[$camera_id] completed"
  else
    echo "[$camera_id] failed; inspect $log_file"
    return 1
  fi
}

download_archives() {
  set +u
  cp "$CAMERA_MANIFEST" "$ARCHIVE_DIR/cameras.json"

  cookie_header=$(build_cookie_header)
  batch_pids=()
  batch_count=0

  while IFS=$'\t' read -r camera_id camera_name; do
    download_camera "$camera_id" "$camera_name" "$cookie_header" &
    pid="$!"
    PIDS+=("$pid")
    batch_pids+=("$pid")
    batch_count=$((batch_count + 1))

    if (( batch_count >= DOWNLOAD_JOBS )); then
      for batch_pid in "${batch_pids[@]}"; do
        wait "$batch_pid" || true
      done

      batch_pids=()
      batch_count=0
    fi
  done < <(
    jq -r '.[] | [.id, .name] | @tsv' "$CAMERA_MANIFEST"
  )

  for batch_pid in "${batch_pids[@]}"; do
    wait "$batch_pid" || true
  done

  PIDS=()
  unset cookie_header

  echo
  echo "Download pass completed."
  echo "Archive folder: $ARCHIVE_DIR"
  echo "Completed files: $(find "$ARCHIVE_DIR" -maxdepth 1 -type f -name 'cam*.mp4' | wc -l | tr -d ' ')"
}

usage() {
  echo "Usage:"
  echo "  $0 stream     Stream organizer feeds directly to MediaMTX"
  echo "  $0 download   Download all complete organizer archives"
}

require_command curl
require_command jq
require_command ffmpeg
require_command ffprobe

case "${1:-}" in
  stream)
    authenticate
    stream_remote
    ;;
  download)
    authenticate
    download_archives
    ;;
  *)
    usage
    exit 1
    ;;
esac
