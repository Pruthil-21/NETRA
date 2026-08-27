#!/usr/bin/env bash

set -u

stream_dir="$(cd "$(dirname "$0")" && pwd)"
log_dir="$stream_dir/logs"

mkdir -p "$log_dir"

mediamtx_pid=""
proxies_pid=""
cloudflare_pid=""

cleanup() {
  trap - EXIT INT TERM

  echo
  echo "Stopping NETRA streaming services..."

  [ -n "$cloudflare_pid" ] && kill "$cloudflare_pid" 2>/dev/null
  [ -n "$proxies_pid" ] && kill "$proxies_pid" 2>/dev/null
  [ -n "$mediamtx_pid" ] && kill "$mediamtx_pid" 2>/dev/null

  wait 2>/dev/null

  echo "All streaming services stopped."
  exit 0
}

trap cleanup EXIT INT TERM

if [ ! -x "$stream_dir/mediamtx" ]; then
  echo "Error: mediamtx executable is missing."
  exit 1
fi

if [ ! -x "$stream_dir/start_live_proxies.sh" ]; then
  echo "Error: start_live_proxies.sh is missing or not executable."
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Error: cloudflared is not installed."
  exit 1
fi

echo "Starting MediaMTX..."

"$stream_dir/mediamtx" "$stream_dir/mediamtx.yml" \
  >"$log_dir/mediamtx.log" 2>&1 &
mediamtx_pid=$!

mediamtx_ready="no"

for attempt in $(seq 1 30); do
  if curl -s --max-time 1 "http://localhost:8888" >/dev/null 2>&1; then
    mediamtx_ready="yes"
    break
  fi

  sleep 1
done

if [ "$mediamtx_ready" != "yes" ]; then
  echo "Error: MediaMTX did not start."
  echo "Check: $log_dir/mediamtx.log"
  exit 1
fi

echo "MediaMTX started."

echo "Starting camera proxies..."

(
  cd "$stream_dir"
  exec ./start_live_proxies.sh
) >"$log_dir/proxies.log" 2>&1 &
proxies_pid=$!

echo "Camera proxies started."

echo "Starting Cloudflare Tunnel..."

cloudflared tunnel --url "http://localhost:8888" \
  >"$log_dir/cloudflare.log" 2>&1 &
cloudflare_pid=$!

tunnel_url=""

for attempt in $(seq 1 30); do
  tunnel_url=$(
    grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' \
      "$log_dir/cloudflare.log" 2>/dev/null |
      tail -n 1
  )

  if [ -n "$tunnel_url" ]; then
    break
  fi

  sleep 1
done

if [ -z "$tunnel_url" ]; then
  echo "Error: Cloudflare Tunnel URL was not created."
  echo "Check: $log_dir/cloudflare.log"
  exit 1
fi

echo
echo "NETRA streaming is running."
echo
echo "Cloudflare base URL:"
echo "$tunnel_url"
echo
echo "Camera 16 test URL:"
echo "$tunnel_url/stream/16/index.m3u8"
echo
echo "Logs are available in:"
echo "$log_dir"
echo
echo "Press Control+C to stop all services."

while true; do
  if ! kill -0 "$mediamtx_pid" 2>/dev/null; then
    echo "MediaMTX stopped unexpectedly."
    exit 1
  fi

  if ! kill -0 "$proxies_pid" 2>/dev/null; then
    echo "Camera proxies stopped unexpectedly."
    exit 1
  fi

  if ! kill -0 "$cloudflare_pid" 2>/dev/null; then
    echo "Cloudflare Tunnel stopped unexpectedly."
    exit 1
  fi

  sleep 5
done
