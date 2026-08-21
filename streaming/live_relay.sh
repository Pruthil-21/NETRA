#!/bin/bash
STREAM_URL="https://live.sentinelgujarat.in/stream/29"
RTSP_OUT="rtsp://localhost:8554/sentinel_cam29"

echo "Starting Sentinel Gujarat persistent live relay to $RTSP_OUT..."

while true; do
  ffmpeg -re \
    -headers "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"$'\r\n'"Referer: https://live.sentinelgujarat.in/camera/29"$'\r\n' \
    -ss 9300 \
    -i "$STREAM_URL" \
    -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p \
    -an -f rtsp "$RTSP_OUT"
  
  echo "Connection dropped by server. Reconnecting in 1 second..."
  sleep 1
done
