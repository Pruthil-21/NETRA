#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

PORTAL_URL="${PORTAL_URL:-https://cctv.corp8.cloud}"
MEDIAMTX_HOST="${MEDIAMTX_HOST:-mediamtx}"
MEDIAMTX_PORT="${MEDIAMTX_PORT:-8554}"
if [[ ! "${MEDIAMTX_PUBLISH_PASSWORD:-}" =~ ^[a-fA-F0-9]{64}$ ]]; then
  echo "MEDIAMTX_PUBLISH_PASSWORD must be 64 hexadecimal characters" >&2
  exit 1
fi
PASSWORD_FILE="${ORGANIZER_PASSWORD_FILE:-/run/secrets/organizer_password}"
EMAIL_FILE="${ORGANIZER_EMAIL_FILE:-/run/secrets/organizer_email}"
CAMERA_LIMIT="${CAMERA_LIMIT:-30}"
STREAM_PREFIX="${STREAM_PREFIX:-direct}"
RETRY_SECONDS="${RETRY_SECONDS:-10}"
MAX_RETRY_SECONDS="${MAX_RETRY_SECONDS:-300}"
CONNECT_INTERVAL_SECONDS="${CONNECT_INTERVAL_SECONDS:-5}"
RATE_LIMIT_SECONDS="${RATE_LIMIT_SECONDS:-300}"
MAX_RATE_LIMIT_SECONDS="${MAX_RATE_LIMIT_SECONDS:-3600}"
AUTH_REFRESH_SECONDS="${AUTH_REFRESH_SECONDS:-600}"
STALL_SECONDS="${STALL_SECONDS:-45}"
RELAY_FPS="${RELAY_FPS:-15}"
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

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for variable_name in CAMERA_LIMIT RETRY_SECONDS MAX_RETRY_SECONDS CONNECT_INTERVAL_SECONDS RATE_LIMIT_SECONDS MAX_RATE_LIMIT_SECONDS AUTH_REFRESH_SECONDS STALL_SECONDS RELAY_FPS; do
  value="${!variable_name}"

  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "$variable_name must be a positive integer." >&2
    exit 1
  fi
done
(( RELAY_FPS <= 60 )) || { echo "RELAY_FPS must be at most 60." >&2; exit 1; }

if [[ ! -s "$EMAIL_FILE" ]]; then
  echo "Organizer email file is missing or empty: $EMAIL_FILE" >&2
  exit 1
fi

if [[ ! -s "$PASSWORD_FILE" ]]; then
  echo "Organizer password file is missing or empty: $PASSWORD_FILE" >&2
  exit 1
fi

# Keep cooldown state across process restarts inside this container.
rm -rf "$STATUS_DIR"
rm -f "$MANIFEST" "$RUNTIME_DIR/auth-success"
mkdir -p "$STATUS_DIR"
chmod 700 "$RUNTIME_DIR"
source /usr/local/bin/organizer-request-gate.sh

organizer_curl() {
  local result=0 retry_after
  curl "$@" -D "$RUNTIME_DIR/auth-headers" || result=$?
  if grep -Eq '^HTTP/[^ ]+ 429([[:space:]]|$)' "$RUNTIME_DIR/auth-headers"; then
    retry_after=$(awk 'tolower($1)=="retry-after:" {gsub("\r", ""); $1=""; sub(/^ /, ""); print; exit}' "$RUNTIME_DIR/auth-headers")
    if [[ -n "$retry_after" && ! "$retry_after" =~ ^[0-9]+$ ]]; then
      retry_after=$(date -d "$retry_after" +%s 2>/dev/null || echo 0)
      retry_after=$((retry_after - $(date +%s)))
    fi
    gate_rate_limited "$retry_after"
    return 1
  fi
  return "$result"
}

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
  gate_slot
  local email
  local password
  local temporary_cookie
  local temporary_manifest

  email="$(<"$EMAIL_FILE")"
  password="$(<"$PASSWORD_FILE")"
  temporary_cookie="$RUNTIME_DIR/cookies.tmp"
  temporary_manifest="$RUNTIME_DIR/cameras.tmp"

  rm -f "$temporary_cookie" "$temporary_manifest"

  organizer_curl -4 -fsSL \
    --connect-timeout 10 \
    --max-time 60 \
    -c "$temporary_cookie" \
    -o /dev/null \
    "$PORTAL_URL/" || return 1

  organizer_curl -4 -fsSL \
    --connect-timeout 10 \
    --max-time 60 \
    -b "$temporary_cookie" \
    -c "$temporary_cookie" \
    --data-urlencode "email=$email" \
    --data-urlencode "password=$password" \
    -o /dev/null \
    "$PORTAL_URL/auth/login" || return 1

  unset email password

  organizer_curl -4 -fsSL \
    --connect-timeout 10 \
    --max-time 60 \
    -b "$temporary_cookie" \
    -c "$temporary_cookie" \
    -o "$temporary_manifest" \
    "$PORTAL_URL/cameras.json" || return 1

  jq -e \
    --argjson camera_limit "$CAMERA_LIMIT" \
    'type == "array" and length > 0 and
     (.[0:$camera_limit] | all(.[]; (.id | type == "string") and (.id | test("^cam[0-9]+$")))) and
     (.[0:$camera_limit] | map(.id) | length == (unique | length))' \
    "$temporary_manifest" >/dev/null || return 1

  chmod 600 "$temporary_cookie" "$temporary_manifest"
  mv -f "$temporary_cookie" "$COOKIE_JAR"
  mv -f "$temporary_manifest" "$MANIFEST"
  date +%s > "$RUNTIME_DIR/auth-success"
}

authentication_loop() {
  local retry_delay="$RETRY_SECONDS"
  while true; do
    if authenticate; then
      log "Organizer authentication refreshed successfully."
      retry_delay="$RETRY_SECONDS"
      sleep "$AUTH_REFRESH_SECONDS"
    else
      log "Organizer authentication failed; feeds remain offline."
      sleep "$retry_delay"
      retry_delay=$((retry_delay * 2))
      (( retry_delay <= MAX_RETRY_SECONDS )) || retry_delay=$MAX_RETRY_SECONDS
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

publisher_errors() {
  local line
  while IFS= read -r line; do
    if [[ "$line" == *"429 Too Many Requests"* || "$line" == *"HTTP error 429"* ]]; then
      gate_rate_limited
    fi
    printf '%s\n' "${line//${MEDIAMTX_PUBLISH_PASSWORD}/[redacted]}" >&2
  done
}

publish_camera() {
  local camera_id="$1"
  local cookies="$2"
  local source_url
  local target_url

  source_url="${PORTAL_URL%/}/$camera_id/index.m3u8"
  target_url="rtsp://publisher:${MEDIAMTX_PUBLISH_PASSWORD}@${MEDIAMTX_HOST}:${MEDIAMTX_PORT}/stream/${STREAM_PREFIX}-${camera_id}"

  if [[ "$camera_id" =~ $TRANSCODE_CAMERAS ]]; then
    log "[$camera_id] relay mode=H.264 transcode"

    exec ffmpeg \
      -nostdin \
      -hide_banner \
      -loglevel warning \
      -re \
      -rw_timeout 15000000 \
      -http_persistent 0 \
      -user_agent "$USER_AGENT" \
      -headers "Cookie: $cookies"$'\r\n'"Referer: $PORTAL_URL/"$'\r\n' \
      -i "$source_url" \
      -map 0:v:0 \
      -an \
      -vf "scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:black,fps=$RELAY_FPS" \
      -c:v libx264 \
      -preset ultrafast \
      -tune zerolatency \
      -b:v 1000k \
      -maxrate 1200k \
      -bufsize 2000k \
      -pix_fmt yuv420p \
      -g "$RELAY_FPS" \
      -keyint_min "$RELAY_FPS" \
      -bf 0 \
      -sc_threshold 0 \
      -threads 1 \
      -f rtsp \
      -rtsp_transport tcp \
      "$target_url"
  else
    log "[$camera_id] relay mode=stream copy"

    exec ffmpeg \
      -nostdin \
      -hide_banner \
      -loglevel warning \
      -re \
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

  /usr/local/bin/hls-probe \
    "http://${MEDIAMTX_HOST}:8888/stream/${STREAM_PREFIX}-${camera_id}/index.m3u8?cookieCheck=1" \
    "$STATUS_DIR/$camera_id" "$STALL_SECONDS"
}

camera_supervisor() (
  local camera_id="$1"
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
  local cookies
  local camera_number
  local initial_delay
  local retry_delay="$RETRY_SECONDS" started_at

  camera_number="${camera_id#cam}"
  initial_delay=$((10#$camera_number % 10))

  printf '%s\n' offline > "$STATUS_DIR/$camera_id"
  sleep "$initial_delay"

  while true; do
    printf '%s\n' offline > "$STATUS_DIR/$camera_id"

    gate_slot
    cookies="$(cookie_header 2>/dev/null || true)"

    if [[ -z "$cookies" ]]; then
      sleep "$((RETRY_SECONDS + RANDOM % 5))"
      continue
    fi

    printf '%s\n' checking > "$STATUS_DIR/$camera_id"

    started_at=$(date +%s)
    publish_camera "$camera_id" "$cookies" 2> >(publisher_errors) &
    publisher_pid="$!"

    hls_ready=0

    for _ in {1..8}; do
      sleep 5

      if gate_cooling; then break; fi

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
      sleep "$((retry_delay + RANDOM % 5))"
      retry_delay=$((retry_delay * 2))
      (( retry_delay <= MAX_RETRY_SECONDS )) || retry_delay=$MAX_RETRY_SECONDS
      continue
    fi

    printf '%s\n' online > "$STATUS_DIR/$camera_id"
    log "[$camera_id] source=organizer-live HLS=playable status=online"

    hls_failures=0
    probe_ticks=0

    while kill -0 "$publisher_pid" 2>/dev/null; do
      sleep 5

      if gate_cooling; then
        kill -TERM "$publisher_pid" 2>/dev/null || true
        break
      fi

      probe_ticks=$((probe_ticks + 1))
      if (( probe_ticks < 3 )); then continue; fi
      probe_ticks=0

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
    # Brief initial playback is not recovery; only reset after stable service.
    if (( $(date +%s) - started_at >= 300 )); then retry_delay="$RETRY_SECONDS"; fi
    sleep "$((retry_delay + RANDOM % 5))"
    retry_delay=$((retry_delay * 2))
    (( retry_delay <= MAX_RETRY_SECONDS )) || retry_delay=$MAX_RETRY_SECONDS
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
wait -n || true
log "A required supervisor exited; restarting the container is required."
exit 1
