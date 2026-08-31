#!/usr/bin/env bash
# Pull every Corp8 HLS feed returned by the provider, transcode it to AVC, and
# publish it to MediaMTX at the matching local path: stream/<camera-id>.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_URL="${NETRA_CAMERA_API_URL:-https://live.corp8.cloud/api/cameras}"
HLS_BASE_URL="${NETRA_CAMERA_HLS_BASE_URL:-https://live.corp8.cloud}"
RTSP_BASE_URL="${NETRA_MEDIAMTX_RTSP_URL:-rtsp://localhost:8554}"
PID_FILE="$DIR/.live-proxies.pid"
RETRY_SECONDS="${NETRA_PROXY_RETRY_SECONDS:-10}"
SOURCE_COOKIE="${NETRA_CAMERA_COOKIE:-cookieCheck=1; path=/; domain=live.corp8.cloud}"
SOURCE_USER_AGENT="${NETRA_CAMERA_USER_AGENT:-Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command not found: $1" >&2
    exit 1
  }
}

cleanup() {
  local status=$?
  local job_pid
  trap - EXIT INT TERM

  echo "Stopping live proxy streams..."

  while read -r job_pid; do
    [[ -n "$job_pid" ]] || continue
    pkill -TERM -P "$job_pid" 2>/dev/null || true
    kill "$job_pid" 2>/dev/null || true
  done < <(jobs -pr)

  wait 2>/dev/null || true
  rm -f "$PID_FILE"
  exit "$status"
}

if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(<"$PID_FILE")"
  if kill -0 "$existing_pid" 2>/dev/null; then
    echo "Live proxies are already running (PID $existing_pid). Stop that process before starting another set." >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

require_command curl
require_command jq
require_command ffmpeg

# An optional list of IDs lets the demo run a subset, while the default is all
# cameras returned in the provider metadata.
REQUESTED_IDS=("$@")
if [[ "${REQUESTED_IDS[0]:-}" == "--help" ]]; then
  cat <<'USAGE'
Usage: ./start_live_proxies.sh [CAMERA_ID ...]

With no camera IDs, starts every camera returned by the provider metadata.
With IDs, starts only the requested camera IDs.
USAGE
  exit 0
fi

echo "Fetching camera metadata from $API_URL..."
CAMERAS_JSON="$(curl --fail --silent --show-error --location \
  --retry 3 --retry-all-errors --connect-timeout 10 --max-time 45 "$API_URL")"

# The provider has returned both a bare array and {"cameras": [...]} over
# time. Normalize either response before optional ID filtering.
FILTER='(if type == "array" then . else (.cameras // .data // []) end)'
if (( ${#REQUESTED_IDS[@]} > 0 )); then
  requested_json="$(printf '%s\n' "${REQUESTED_IDS[@]}" | jq -R . | jq -s .)"
  FILTER+=" | map(select((.id | tostring) as \$id | \$requested | index(\$id)))"
fi

if (( ${#REQUESTED_IDS[@]} > 0 )); then
  CAMERA_ROWS="$(jq -r --argjson requested "$requested_json" "$FILTER | .[] | [(.id | tostring), (.location // .name // \"unknown\" | tostring), (.hls_live_url // (\"/live/stream/\" + (.id | tostring) + \"/index.m3u8\"))] | @tsv" <<<"$CAMERAS_JSON")"
else
  CAMERA_ROWS="$(jq -r "$FILTER | .[] | [(.id | tostring), (.location // .name // \"unknown\" | tostring), (.hls_live_url // (\"/live/stream/\" + (.id | tostring) + \"/index.m3u8\"))] | @tsv" <<<"$CAMERAS_JSON")"
fi

if [[ -z "$CAMERA_ROWS" ]]; then
  echo "No cameras were returned by the provider." >&2
  exit 1
fi

publish_camera() {
  local camera_id="$1"
  local hls_path="$2"
  local source_url

  if [[ "$hls_path" == http://* || "$hls_path" == https://* ]]; then
    source_url="$hls_path"
  else
    source_url="${HLS_BASE_URL%/}/${hls_path#/}"
  fi

  while true; do
    echo "[camera $camera_id] Pulling $source_url -> ${RTSP_BASE_URL%/}/stream/$camera_id"
    ffmpeg -hide_banner -loglevel warning -nostdin \
      -rw_timeout 15000000 \
      -http_persistent 0 \
      -cookies "$SOURCE_COOKIE" \
      -user_agent "$SOURCE_USER_AGENT" \
      -referer "${HLS_BASE_URL%/}/" \
      -reconnect 1 -reconnect_streamed 1 -reconnect_on_http_error 4xx,5xx \
      -reconnect_delay_max 5 \
      -i "$source_url" \
      -map 0:v:0 -an \
      -c:v libx264 -pix_fmt yuv420p -preset ultrafast -tune zerolatency \
      -force_key_frames "expr:gte(t,n_forced*1)" -sc_threshold 0 \
      -f rtsp -rtsp_transport tcp \
      "${RTSP_BASE_URL%/}/stream/$camera_id" || true
    echo "[camera $camera_id] Source/publish disconnected; retrying in ${RETRY_SECONDS}s..." >&2
    sleep "$RETRY_SECONDS"
  done
}

echo "Starting AVC proxies for provider cameras:"
while IFS=$'\t' read -r camera_id location hls_path; do
  [[ -n "$camera_id" ]] || continue
  printf '  %-4s %s\n' "$camera_id" "$location"
  publish_camera "$camera_id" "$hls_path" &
done <<<"$CAMERA_ROWS"

echo "$$" > "$PID_FILE"
trap cleanup EXIT INT TERM
echo "Live proxies are running. Press Ctrl+C to stop."
wait
