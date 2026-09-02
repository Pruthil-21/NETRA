#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log_dir="$script_dir/logs"
camera_limit="${CAMERA_LIMIT:-10}"
cloudflare_protocol="${CLOUDFLARE_PROTOCOL:-http2}"

mediamtx_pid=""
cloudflared_pid=""
caffeinate_pid=""

mkdir -p "$log_dir"

timestamp="$(date '+%Y%m%d-%H%M%S')"
mediamtx_log="$log_dir/mediamtx-$timestamp.log"
cloudflared_log="$log_dir/cloudflared-$timestamp.log"

cleanup() {
  trap - EXIT INT TERM
  echo
  echo "Stopping NETRA organizer stack..."

  if [[ -n "$cloudflared_pid" ]] &&
    kill -0 "$cloudflared_pid" 2>/dev/null; then
    kill -TERM "$cloudflared_pid" 2>/dev/null || true
  fi

  if [[ -n "$mediamtx_pid" ]] &&
    kill -0 "$mediamtx_pid" 2>/dev/null; then
    kill -TERM "$mediamtx_pid" 2>/dev/null || true
  fi

  if [[ -n "$caffeinate_pid" ]] &&
    kill -0 "$caffeinate_pid" 2>/dev/null; then
    kill -TERM "$caffeinate_pid" 2>/dev/null || true
  fi

  wait 2>/dev/null || true
  echo "NETRA organizer stack stopped."
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

trap cleanup EXIT INT TERM

[[ "$camera_limit" =~ ^[1-9][0-9]*$ ]] ||
  fail "CAMERA_LIMIT must be a positive integer."

for required_file in \
  "$script_dir/mediamtx" \
  "$script_dir/mediamtx.yml" \
  "$script_dir/organizer_remote_feeds.sh"
do
  [[ -e "$required_file" ]] || fail "Missing $required_file"
done

for required_command in cloudflared curl grep; do
  command -v "$required_command" >/dev/null 2>&1 ||
    fail "Missing required command: $required_command"
done

if pgrep -x mediamtx >/dev/null 2>&1; then
  fail "MediaMTX is already running. Stop it before starting this stack."
fi

if pgrep -x cloudflared >/dev/null 2>&1; then
  fail "cloudflared is already running. Stop it before starting this stack."
fi

if pgrep -f 'ffmpeg.*stream/direct-cam' >/dev/null 2>&1; then
  fail "Direct-camera relays are already running."
fi

if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -dimsu -w "$$" &
  caffeinate_pid=$!
fi

echo "Starting MediaMTX..."
"$script_dir/mediamtx" "$script_dir/mediamtx.yml" \
  >>"$mediamtx_log" 2>&1 &
mediamtx_pid=$!

hls_ready=0
for _ in {1..30}; do
  if ! kill -0 "$mediamtx_pid" 2>/dev/null; then
    tail -n 20 "$mediamtx_log" >&2 || true
    fail "MediaMTX exited during startup."
  fi

  if curl -sS --max-time 2 -o /dev/null \
    http://127.0.0.1:8888/ 2>/dev/null; then
    hls_ready=1
    break
  fi
  sleep 1
done

(( hls_ready == 1 )) ||
  fail "MediaMTX HLS did not become ready within 30 seconds."

echo "Starting Cloudflare Quick Tunnel using $cloudflare_protocol..."
cloudflared tunnel \
  --protocol "$cloudflare_protocol" \
  --url http://127.0.0.1:8888 \
  >"$cloudflared_log" 2>&1 &
cloudflared_pid=$!

public_base=""
for _ in {1..60}; do
  if ! kill -0 "$cloudflared_pid" 2>/dev/null; then
    tail -n 30 "$cloudflared_log" >&2 || true
    fail "cloudflared exited during startup."
  fi

  public_base="$(
    grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' \
      "$cloudflared_log" 2>/dev/null |
      head -n 1 || true
  )"

  if [[ -n "$public_base" ]]; then
    break
  fi
  sleep 1
done

[[ -n "$public_base" ]] ||
  fail "Cloudflare URL was not created within 60 seconds."

echo
echo "Public base URL: $public_base"
echo "Camera 01 HLS: $public_base/stream/direct-cam01/index.m3u8"
echo "Camera limit: $camera_limit"
echo "MediaMTX log: $mediamtx_log"
echo "Cloudflare log: $cloudflared_log"
echo
echo "Starting organizer relays."
echo "Press Control+C once to stop everything."
echo
export CAMERA_LIMIT="$camera_limit"
"$script_dir/organizer_remote_feeds.sh" stream
