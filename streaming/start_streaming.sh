#!/usr/bin/env bash

set -u

stream_dir="$(cd "$(dirname "$0")" && pwd)"
log_dir="$stream_dir/logs"

mkdir -p "$log_dir"

mediamtx_pid=""
proxies_pid=""
cloudflare_pid=""
go2rtc_pid=""
xiaomi_relay_pid=""
xiaomi_enabled="no"
phone_relay_pid=""
phone_relay_enabled="no"
cleanup() {
  trap - EXIT INT TERM

  echo
  echo "Stopping NETRA streaming services..."
  [ -n "$phone_relay_pid" ] && kill "$phone_relay_pid" 2>/dev/null
    [ -n "$xiaomi_relay_pid" ] && kill "$xiaomi_relay_pid" 2>/dev/null
  [ -n "$go2rtc_pid" ] && kill "$go2rtc_pid" 2>/dev/null
  [ -n "$cloudflare_pid" ] && kill "$cloudflare_pid" 2>/dev/null
  [ -n "$proxies_pid" ] && kill "$proxies_pid" 2>/dev/null
    pkill -TERM -f 'ffmpeg.*live.corp8.cloud/live/stream/' 2>/dev/null || true
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
if [ -x "$stream_dir/go2rtc" ] &&
   [ -f "$stream_dir/go2rtc.yaml" ] &&
   [ -x "$stream_dir/start_xiaomi_camera.sh" ]; then

  echo "Starting go2rtc..."

  (
    cd "$stream_dir"
    exec ./go2rtc
  ) >"$log_dir/go2rtc.log" 2>&1 &

  go2rtc_pid=$!
  go2rtc_ready="no"

  for attempt in $(seq 1 20); do
    if curl -s --max-time 1 http://127.0.0.1:1984 >/dev/null 2>&1; then
      go2rtc_ready="yes"
      break
    fi
    sleep 1
  done

  if [ "$go2rtc_ready" = "yes" ]; then
    echo "go2rtc started."
    echo "Starting Xiaomi camera relay..."

    "$stream_dir/start_xiaomi_camera.sh" \
      >"$log_dir/xiaomi-camera.log" 2>&1 &

    xiaomi_relay_pid=$!
    xiaomi_enabled="yes"

    echo "Xiaomi camera relay started."
  else
    echo "Warning: go2rtc did not start; Xiaomi camera will be unavailable."
    kill "$go2rtc_pid" 2>/dev/null
    go2rtc_pid=""
  fi
else
  echo "Xiaomi camera integration skipped; local go2rtc files are missing."
fi
if [ -x "$stream_dir/start_phone_relay.sh" ]; then
  echo "Starting phone camera relay..."

  "$stream_dir/start_phone_relay.sh" \
    >"$log_dir/pruthil-phone.log" 2>&1 &

  phone_relay_pid=$!
  phone_relay_enabled="yes"

  echo "Phone camera relay started."
else
  echo "Phone camera relay skipped; start_phone_relay.sh is missing."
fi

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
if [ "$phone_relay_enabled" = "yes" ]; then
  echo
  echo "Pruthil phone camera URL:"
  echo "$tunnel_url/stream/pruthil-phone/index.m3u8"
fi
if [ "$xiaomi_enabled" = "yes" ]; then
  echo
  echo "Xiaomi camera URL:"
  echo "$tunnel_url/stream/xiaomi-camera/index.m3u8"
fi
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
    if [ "$xiaomi_enabled" = "yes" ]; then
    if ! kill -0 "$go2rtc_pid" 2>/dev/null; then
      echo "go2rtc stopped unexpectedly."
      exit 1
    fi

    if ! kill -0 "$xiaomi_relay_pid" 2>/dev/null; then
      echo "Xiaomi camera relay stopped unexpectedly."
      exit 1
    fi
  fi
    if [ "$phone_relay_enabled" = "yes" ] &&
     ! kill -0 "$phone_relay_pid" 2>/dev/null; then
    echo "Phone camera relay stopped unexpectedly."
    exit 1
  fi
  sleep 5
done
