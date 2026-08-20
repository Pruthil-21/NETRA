#!/bin/bash
INPUT_VIDEO="videos/camera1.mp4"
STREAM_NAME="camera1"

if [ ! -f "$INPUT_VIDEO" ]; then
    echo "Video file $INPUT_VIDEO not found! Generating test video..."
    mkdir -p videos
    ffmpeg -f lavfi -i "testsrc=size=1280x720:rate=25" -t 20 -c:v libx264 -pix_fmt yuv420p "$INPUT_VIDEO"
fi

echo "Publishing looped video to rtsp://localhost:8554/$STREAM_NAME ..."
ffmpeg -re -stream_loop -1 -i "$INPUT_VIDEO" -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -an -f rtsp rtsp://localhost:8554/$STREAM_NAME
