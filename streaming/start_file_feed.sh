#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT_VIDEO="${INPUT_VIDEO:-$SCRIPT_DIR/videos/camera1.mp4}"
STREAM_NAME="camera1"

if [ ! -f "$INPUT_VIDEO" ]; then
    echo "Video file $INPUT_VIDEO not found! Generating test video..."
    mkdir -p "$(dirname "$INPUT_VIDEO")"
    ffmpeg -f lavfi -i "testsrc=size=1280x720:rate=25" -t 20 -c:v libx264 -pix_fmt yuv420p "$INPUT_VIDEO"
fi

echo "Publishing looped video to rtsp://localhost:8554/$STREAM_NAME ..."
exec ffmpeg -nostdin -re -stream_loop -1 -i "$INPUT_VIDEO" -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -g 25 -bf 0 -an -f rtsp -rtsp_transport tcp "rtsp://localhost:8554/$STREAM_NAME"
