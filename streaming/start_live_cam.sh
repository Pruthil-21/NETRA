#!/bin/bash
set -euo pipefail
STREAM_NAME="livecam"
DEVICE_INDEX="0"

echo "Publishing live webcam to rtsp://localhost:8554/$STREAM_NAME ..."
exec ffmpeg -nostdin -f avfoundation -framerate 30 -video_size 1280x720 -i "$DEVICE_INDEX" \
  -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p \
  -g 30 -bf 0 -an -f rtsp -rtsp_transport tcp "rtsp://localhost:8554/$STREAM_NAME"
