#!/usr/bin/env bash
set -Eeuo pipefail

PORTAL_URL="${PORTAL_URL:-https://cctv.corp8.cloud}"
MEDIAMTX_HOST="${MEDIAMTX_HOST:-mediamtx}"
MEDIAMTX_PORT="${MEDIAMTX_PORT:-8554}"
PASSWORD_FILE="${ORGANIZER_PASSWORD_FILE:-/run/secrets/organizer_password}"
EMAIL_FILE="${ORGANIZER_EMAIL_FILE:-/run/secrets/organizer_email}"
CAMERA_LIMIT="${CAMERA_LIMIT:-30}"
STREAM_PREFIX="${STREAM_PREFIX:-direct}"
RETRY_SECONDS="${RETRY_SECONDS:-10}"
AUTH_REFRESH_SECONDS="${AUTH_REFRESH_SECONDS:-600}"
TRANSCODE_CAMERAS="${TRANSCODE_CAMERAS:-^(cam09|cam15|cam18|cam24|cam27|cam29|cam30)$}"
USER_AGENT="${SOURCE_USER_AGENT:-Mozilla/5.0}"

RUNTIME_DIR="/tmp/netra-live"
STATUS_DIR="$RUNTIME_DIR/status"
COOKIE_JAR="$RUNTIME_DIR/cookies.txt"
MANIFEST="$RUNTIME_DIR/cameras.json"
PIDS=()

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

cleanup() {
  trap - EXIT INT TERM
  log "Stopping Organizer live-feed relays."

  for pid in "${PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  wait 2>/dev/null || true
}

trap cleanup EXIT INT TERM

for variable_name in CAMERA_LIMIT RETRY_SECONDS AUTH_REFRESH_SECONDS; do
  value="${!variable_name}"

  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "$variable_name must be a positive integer." >&2
    exit 1
  fi
done

if [[ ! -s "$EMAIL_FILE" ]]; then
  echo "Organizer email file is missing or empty: $EMAIL_FILE" >&2
  exit 1
fi

if [[ ! -s "$PASSWORD_FILE" ]]; then
  echo "Organizer password file is missing or empty: $PASSWORD_FILE" >&2
  exit 1
fi

rm -rf "$RUNTIME_DIR"
mkdir -p "$STATUS_DIR"
chmod 700 "$RUNTIME_DIR"

log "Waiting for MediaMTX at $MEDIAMTX_HOST:$MEDIAMTX_PORT."

mediamtx_ready=0

for _ in {1..60}; do
  if timeout 1 bash -c \
    "</dev/tcp/$MEDIAMTX_HOST/$MEDIAMTX_PORT" 2>/dev/null; then
    mediamtx_ready=1
    break
  fi

  sleep 1
done

if (( mediamtx_ready == 0 )); then
  echo "MediaMTX did not become ready within 60 seconds." >&2
  exit 1
fi

authenticate() {
  local email
  local password
  local temporary_cookie
  local temporary_manifest

  email="$(<"$EMAIL_FILE")"
  password="$(<"$PASSWORD_FILE")"
  temporary_cookie="$RUNTIME_DIR/cookies.tmp"
  temporary_manifest="$RUNTIME_DIR/cameras.tmp"

  rm -f "$temporary_cookie" "$temporary_manifest"

  curl -fsSL \
    --connect-timeout 10 \
    --max-time 20 \
    -c "$temporary_cookie" \
    -o /dev/null \
    "$PORTAL_URL/" || return 1

  curl -fsSL \
    --connect-timeout 10 \
    --max-time 20 \
    -b "$temporary_cookie" \
    -c "$temporary_cookie" \
    --data-urlencode "email=$email" \
    --data-urlencode "password=$password" \
    -o /dev/null \
    "$PORTAL_URL/auth/login" || return 1

  unset email password

  curl -fsSL \
    --connect-timeout 10 \
    --max-time 30 \
    -b "$temporary_cookie" \
    -c "$temporary_cookie" \
    -o "$temporary_manifest" \
    "$PORTAL_URL/cameras.json" || return 1

  jq -e \
    --argjson camera_limit "$CAMERA_LIMIT" \
    'type == "array" and length >= $camera_limit' \
    "$temporary_manifest" >/dev/null || return 1

  chmod 600 "$temporary_cookie" "$temporary_manifest"
  mv -f "$temporary_cookie" "$COOKIE_JAR"
  mv -f "$temporary_manifest" "$MANIFEST"
}

authentication_loop() {
  while true; do
    if authenticate; then
      log "Organizer authentication refreshed successfully."
      sleep "$AUTH_REFRESH_SECONDS"
    else
      log "Organizer authentication failed; feeds remain offline."
      sleep "$RETRY_SECONDS"
    fi
  done
}

cookie_header() {
  if [[ ! -s "$COOKIE_JAR" ]]; then
    return 1
  fi

  awk -F $'\t' '
    NF >= 7 {
      if (cookies != "") {
        cookies = cookies "; "
      }
      cookies = cookies $6 "=" $7
    }
    END {
      print cookies
    }
  ' "$COOKIE_JAR"
}

probe_camera() {
  local camera_id="$1"
  local cookies="$2"
  local source_url

  source_url="${PORTAL_URL%/}/$camera_id/index.m3u8"

  timeout 20 ffmpeg \
    -nostdin \
    -hide_banner \
    -loglevel error \
    -rw_timeout 15000000 \
    -http_persistent 0 \
    -user_agent "$USER_AGENT" \
    -headers "Cookie: $cookies"$'\r\n'"Referer: $PORTAL_URL/"$'\r\n' \
    -i "$source_url" \
    -map 0:v:0 \
    -frames:v 1 \
    -an \
    -f null - \
    >/dev/null 2>&1
}

publish_camera() {
  local camera_id="$1"
  local cookies="$2"
  local source_url
  local target_url

  source_url="${PORTAL_URL%/}/$camera_id/index.m3u8"
  target_url="rtsp://${MEDIAMTX_HOST}:${MEDIAMTX_PORT}/stream/${STREAM_PREFIX}-${camera_id}"

  if [[ "$camera_id" =~ $TRANSCODE_CAMERAS ]]; then
    log "[$camera_id] relay mode=H.264 transcode"

    ffmpeg \
      -nostdin \
      -hide_banner \
      -loglevel warning \
      -rw_timeout 15000000 \
      -http_persistent 0 \
      -user_agent "$USER_AGENT" \
      -headers "Cookie: $cookies"$'\r\n'"Referer: $PORTAL_URL/"$'\r\n' \
      -i "$source_url" \
      -map 0:v:0 \
      -an \
      -vf "scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:black,fps=15" \
      -c:v libx264 \
      -preset ultrafast \
      -tune zerolatency \
      -b:v 1000k \
      -maxrate 1200k \
      -bufsize 2000k \
      -pix_fmt yuv420p \
      -g 30 \
      -keyint_min 30 \
      -sc_threshold 0 \
      -threads 1 \
      -f rtsp \
      -rtsp_transport tcp \
      "$target_url"
  else
    log "[$camera_id] relay mode=stream copy"

    ffmpeg \
      -nostdin \
      -hide_banner \
      -loglevel warning \
      -rw_timeout 15000000 \
      -http_persistent 0 \
      -user_agent "$USER_AGENT" \
      -headers "Cookie: $cookies"$'\r\n'"Referer: $PORTAL_URL/"$'\r\n' \
      -i "$source_url" \
      -map 0:v:0 \
      -an \
      -c:v copy \
      -f rtsp \
      -rtsp_transport tcp \
      "$target_url"
  fi
}

hls_available() {
  local camera_id="$1"

  curl -fsS     --max-time 6     -o /dev/null     "http://${MEDIAMTX_HOST}:8888/stream/${STREAM_PREFIX}-${camera_id}/index.m3u8?cookieCheck=1"
}

camera_supervisor() (
  local camera_id="$1"
  local cookies
  local camera_number
  local initial_delay

  camera_number="${camera_id#cam}"
  initial_delay=$((10#$camera_number % 10))

  printf '%s\n' offline > "$STATUS_DIR/$camera_id"
  sleep "$initial_delay"

  while true; do
    printf '%s\n' offline > "$STATUS_DIR/$camera_id"

    cookies="$(cookie_header 2>/dev/null || true)"

    if [[ -z "$cookies" ]]; then
      sleep "$RETRY_SECONDS"
      continue
    fi

    printf '%s\n' checking > "$STATUS_DIR/$camera_id"

    if ! probe_camera "$camera_id" "$cookies"; then
      printf '%s\n' offline > "$STATUS_DIR/$camera_id"
      log "[$camera_id] Organizer feed unavailable; status=offline"
      sleep "$RETRY_SECONDS"
      continue
    fi

    printf '%s\n' checking > "$STATUS_DIR/$camera_id"
    publish_camera "$camera_id" "$cookies" &
    publisher_pid="$!"

    hls_ready=0

    for _ in {1..8}; do
      sleep 5

      if ! kill -0 "$publisher_pid" 2>/dev/null; then
        break
      fi

      if hls_available "$camera_id"; then
        hls_ready=1
        break
      fi
    done

    if (( hls_ready == 0 )); then
      kill -TERM "$publisher_pid" 2>/dev/null || true
      wait "$publisher_pid" 2>/dev/null || true

      printf '%s\n' offline > "$STATUS_DIR/$camera_id"
      log "[$camera_id] no playable HLS output; status=offline"
      sleep "$RETRY_SECONDS"
      continue
    fi

    printf '%s\n' online > "$STATUS_DIR/$camera_id"
    log "[$camera_id] source=organizer-live HLS=playable status=online"

    hls_failures=0

    while kill -0 "$publisher_pid" 2>/dev/null; do
      sleep 15

      if hls_available "$camera_id"; then
        hls_failures=0
      else
        hls_failures=$((hls_failures + 1))
        log "[$camera_id] HLS health check failed ($hls_failures/2)."
      fi

      if (( hls_failures >= 2 )); then
        kill -TERM "$publisher_pid" 2>/dev/null || true
        break
      fi
    done

    wait "$publisher_pid" 2>/dev/null || true

    printf '%s\n' offline > "$STATUS_DIR/$camera_id"
    log "[$camera_id] Organizer/HLS feed disconnected; status=offline"
    sleep "$RETRY_SECONDS"
  done
)

authentication_loop &
PIDS+=("$!")

while [[ ! -s "$MANIFEST" ]]; do
  log "Waiting for an authenticated Organizer camera manifest."
  sleep 2
done

mapfile -t CAMERA_IDS < <(
  jq -r ".[0:${CAMERA_LIMIT}][].id" "$MANIFEST"
)

for camera_id in "${CAMERA_IDS[@]}"; do
  camera_supervisor "$camera_id" &
  PIDS+=("$!")
done

log "Live-only Organizer camera supervisors launched: ${#CAMERA_IDS[@]}"
log "Recorded fallback is disabled."
wait
