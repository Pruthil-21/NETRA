#!/usr/bin/env bash
set -Eeuo pipefail

ARCHIVE_DIR="${ARCHIVE_DIR:-/recordings}"
MEDIAMTX_HOST="${MEDIAMTX_HOST:-mediamtx}"
MEDIAMTX_PORT="${MEDIAMTX_PORT:-8554}"
EDGE_NODE_ID="${EDGE_NODE_ID:-edge-local-001}"
STREAM_PREFIX="${STREAM_PREFIX:-direct}"
CAMERA_LIMIT="${CAMERA_LIMIT:-30}"
PORTAL_URL="${PORTAL_URL:-https://cctv.corp8.cloud}"
PASSWORD_FILE="${ORGANIZER_PASSWORD_FILE:-/run/secrets/organizer_password}"
CHECK_SECONDS="${LIVE_CHECK_INTERVAL:-20}"
REQUIRED_SUCCESSES="${LIVE_REQUIRED_SUCCESSES:-2}"
PROBE_TIMEOUT="${LIVE_PROBE_TIMEOUT:-12}"
AUTH_REFRESH_SECONDS="${AUTH_REFRESH_SECONDS:-600}"
AUTH_RETRY_SECONDS="${AUTH_RETRY_SECONDS:-30}"
TRANSCODE_CAMERAS="${TRANSCODE_CAMERAS:-^(cam15|cam27|cam29|cam30)$}"
USER_AGENT="${SOURCE_USER_AGENT:-Mozilla/5.0}"

RUNTIME_DIR=/tmp/netra-hybrid
COOKIE_JAR="$RUNTIME_DIR/cookies.txt"
MANIFEST="$RUNTIME_DIR/cameras.json"
STATUS_DIR="$RUNTIME_DIR/status"
PIDS=()

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

cleanup() {
  trap - EXIT INT TERM
  log "Stopping hybrid publishers..."
  for pid in "${PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for name in CAMERA_LIMIT CHECK_SECONDS REQUIRED_SUCCESSES PROBE_TIMEOUT \
  AUTH_REFRESH_SECONDS AUTH_RETRY_SECONDS; do
  value="${!name}"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || {
    echo "$name must be a positive integer." >&2
    exit 1
  }
done

[[ -d "$ARCHIVE_DIR" ]] || {
  echo "Recording directory is unavailable: $ARCHIVE_DIR" >&2
  exit 1
}
[[ -s "$PASSWORD_FILE" ]] || {
  echo "Organizer password file is missing or empty: $PASSWORD_FILE" >&2
  exit 1
}

mkdir -p "$STATUS_DIR"
chmod 700 "$RUNTIME_DIR"

log "Waiting for MediaMTX at $MEDIAMTX_HOST:$MEDIAMTX_PORT..."
ready=0
for _ in {1..60}; do
  if timeout 1 bash -c "</dev/tcp/$MEDIAMTX_HOST/$MEDIAMTX_PORT" \
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

authenticate() {
  local password temp_cookie temp_manifest
  password="$(<"$PASSWORD_FILE")"
  temp_cookie="$RUNTIME_DIR/cookies.tmp"
  temp_manifest="$RUNTIME_DIR/cameras.tmp"
  rm -f "$temp_cookie" "$temp_manifest"

  curl -fsSL --connect-timeout 10 --max-time 20 \
    -c "$temp_cookie" -o /dev/null "$PORTAL_URL/" || return 1
  curl -fsSL --connect-timeout 10 --max-time 20 \
    -b "$temp_cookie" -c "$temp_cookie" \
    --data-urlencode "password=$password" \
    -o /dev/null "$PORTAL_URL/auth/login" || return 1
  unset password
  curl -fsSL --connect-timeout 10 --max-time 30 \
    -b "$temp_cookie" -c "$temp_cookie" \
    -o "$temp_manifest" "$PORTAL_URL/cameras.json" || return 1
  jq -e --argjson expected "$CAMERA_LIMIT" \
    'type == "array" and length >= $expected' \
    "$temp_manifest" >/dev/null || return 1

  chmod 600 "$temp_cookie" "$temp_manifest"
  mv -f "$temp_cookie" "$COOKIE_JAR"
  mv -f "$temp_manifest" "$MANIFEST"
}

authentication_loop() {
  while true; do
    if authenticate; then
      log "Organizer authentication refreshed successfully."
      sleep "$AUTH_REFRESH_SECONDS"
    else
      log "Organizer authentication failed; recordings remain active."
      sleep "$AUTH_RETRY_SECONDS"
    fi
  done
}

cookie_header() {
  [[ -s "$COOKIE_JAR" ]] || return 1
  awk -F $'\t' '
    NF >= 7 {
      if (cookies != "") cookies = cookies "; "
      cookies = cookies $6 "=" $7
    }
    END { print cookies }
  ' "$COOKIE_JAR"
}

source_url() {
  printf '%s/%s/index.m3u8' "${PORTAL_URL%/}" "$1"
}

probe_live() {
  local camera_id="$1" cookies url
  cookies="$(cookie_header)" || return 1
  [[ -n "$cookies" ]] || return 1
  url="$(source_url "$camera_id")"

  timeout "$PROBE_TIMEOUT" ffmpeg \
    -nostdin -hide_banner -loglevel error \
    -rw_timeout 10000000 -http_persistent 0 \
    -user_agent "$USER_AGENT" \
    -headers "Cookie: $cookies"$'\r\n'"Referer: $PORTAL_URL/"$'\r\n' \
    -i "$url" -map 0:v:0 -frames:v 1 -an -f null - \
    >/dev/null 2>&1
}

publish_recording() {
  local camera_id="$1" input_file="$2" target="$3"
  if [[ "$camera_id" =~ $TRANSCODE_CAMERAS ]]; then
    ffmpeg -nostdin -hide_banner -loglevel warning \
      -re -stream_loop -1 -fflags +genpts -i "$input_file" \
      -map 0:v:0 -an -vf fps=20 \
      -c:v libx264 -preset veryfast -tune zerolatency \
      -b:v 2500k -maxrate 3000k -bufsize 5000k \
      -pix_fmt yuv420p -g 20 -keyint_min 20 -sc_threshold 0 -threads 2 \
      -f rtsp -rtsp_transport tcp "$target"
  else
    ffmpeg -nostdin -hide_banner -loglevel warning \
      -re -stream_loop -1 -fflags +genpts -i "$input_file" \
      -map 0:v:0 -an -c:v copy \
      -f rtsp -rtsp_transport tcp "$target"
  fi
}

publish_live() {
  local camera_id="$1" target="$2" cookies url
  cookies="$(cookie_header)" || return 1
  [[ -n "$cookies" ]] || return 1
  url="$(source_url "$camera_id")"

  if [[ ! "$camera_id" =~ $TRANSCODE_CAMERAS ]]; then
    log "[$camera_id] live mode=stream-copy."
    ffmpeg -nostdin -hide_banner -loglevel warning \
      -rw_timeout 15000000 -http_persistent 0 \
      -user_agent "$USER_AGENT" \
      -headers "Cookie: $cookies"$'\r\n'"Referer: $PORTAL_URL/"$'\r\n' \
      -i "$url" -map 0:v:0 -an -c:v copy \
      -f rtsp -rtsp_transport tcp "$target"
  else
    log "[$camera_id] live mode=H.264-transcode."
    ffmpeg -nostdin -hide_banner -loglevel warning \
      -rw_timeout 15000000 -http_persistent 0 \
      -user_agent "$USER_AGENT" \
      -headers "Cookie: $cookies"$'\r\n'"Referer: $PORTAL_URL/"$'\r\n' \
      -i "$url" -map 0:v:0 -an \
      -vf "scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:black,fps=15" \
      -c:v libx264 -preset ultrafast -tune zerolatency \
      -b:v 1000k -maxrate 1200k -bufsize 2000k \
      -pix_fmt yuv420p -g 30 -keyint_min 30 -sc_threshold 0 -threads 1 \
      -f rtsp -rtsp_transport tcp "$target"
  fi
}

camera_supervisor() (
  local input_file="$1" camera_id target publisher_pid=""
  local camera_number initial_delay
  local successes=0 switch_to_live=0
  camera_id="$(basename "$input_file" .mp4)"
  camera_number="${camera_id#cam}"
  initial_delay=$((10#$camera_number % CHECK_SECONDS))
  target="rtsp://${MEDIAMTX_HOST}:${MEDIAMTX_PORT}/stream/${STREAM_PREFIX}-${camera_id}"

  stop_publisher() {
    trap - EXIT INT TERM
    if [[ -n "$publisher_pid" ]]; then
      kill -TERM "$publisher_pid" 2>/dev/null || true
      wait "$publisher_pid" 2>/dev/null || true
    fi
  }
  trap stop_publisher EXIT INT TERM

  while true; do
    log "[$camera_id] source=recorded"
    printf '%s\n' recorded > "$STATUS_DIR/$camera_id"
    publish_recording "$camera_id" "$input_file" "$target" &
    publisher_pid="$!"
    successes=0
    switch_to_live=0

    if (( initial_delay > 0 )); then
      sleep "$initial_delay"
    fi

    while kill -0 "$publisher_pid" 2>/dev/null; do
      sleep "$CHECK_SECONDS"
      if probe_live "$camera_id"; then
        successes=$((successes + 1))
        log "[$camera_id] live probe passed ($successes/$REQUIRED_SUCCESSES)."
      else
        successes=0
      fi
      if (( successes >= REQUIRED_SUCCESSES )); then
        switch_to_live=1
        kill -TERM "$publisher_pid" 2>/dev/null || true
        break
      fi
    done

    wait "$publisher_pid" 2>/dev/null || true
    publisher_pid=""

    if (( switch_to_live == 1 )); then
      log "[$camera_id] source=live"
      printf '%s\n' live > "$STATUS_DIR/$camera_id"
      publish_live "$camera_id" "$target" &
      publisher_pid="$!"
      wait "$publisher_pid" 2>/dev/null || true
      publisher_pid=""
      log "[$camera_id] live feed stopped; returning to recording."
    else
      log "[$camera_id] recording publisher stopped; restarting."
    fi
    sleep 2
  done
)

mapfile -t FILES < <(
  find "$ARCHIVE_DIR" -maxdepth 1 -type f -name 'cam*.mp4' -print |
    sort | sed -n "1,${CAMERA_LIMIT}p"
)
(( ${#FILES[@]} > 0 )) || {
  echo "No cam*.mp4 recordings were found in $ARCHIVE_DIR." >&2
  exit 1
}

log "Edge node: $EDGE_NODE_ID"
log "Hybrid mode: live Organizer feed preferred; recording is fallback."

authentication_loop &
PIDS+=("$!")
for input_file in "${FILES[@]}"; do
  camera_supervisor "$input_file" &
  PIDS+=("$!")
done

log "Hybrid camera supervisors launched: ${#FILES[@]}"
wait
