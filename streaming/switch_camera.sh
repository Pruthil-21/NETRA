#!/usr/bin/env bash
# ==============================================================================
# Sentinel Gujarat On-Demand Camera Streamer
# Bridges remote portal feeds to a local MediaMTX RTSP stream for ML/ANPR ingest.
# ==============================================================================

set -euo pipefail

RTSP_PORT="${RTSP_PORT:-8554}"
RTSP_PATH="${RTSP_PATH:-sentinel_cam}"
RTSP_OUT="rtsp://localhost:${RTSP_PORT}/${RTSP_PATH}"
FFMPEG_PID=""

cleanup() {
  if [[ -n "${FFMPEG_PID}" ]] && kill -0 "${FFMPEG_PID}" 2>/dev/null; then
    kill -9 "${FFMPEG_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "----------------------------------------------------"
echo "  Sentinel Gujarat Live RTSP Broadcaster (NETRA)   "
echo "  Target Output: ${RTSP_OUT}                       "
echo "----------------------------------------------------"

while true; do
  echo ""
  read -r -p "Enter Camera ID (1-31) to stream [or 'q' to quit]: " CAM_ID

  if [[ "${CAM_ID}" =~ ^[qQ]$ ]]; then
    echo "Shutting down stream relay..."
    cleanup
    break
  fi

  if ! [[ "${CAM_ID}" =~ ^[0-9]+$ ]] || [ "${CAM_ID}" -lt 1 ] || [ "${CAM_ID}" -gt 31 ]; then
    echo "⚠️  Invalid selection. Please enter an integer between 1 and 31."
    continue
  fi

  cleanup

  echo "Initializing stream for Camera ${CAM_ID}..."

  # Launch resilient FFmpeg pipeline in background
  ffmpeg -re \
    -nostdin \
    -loglevel warning \
    -reconnect 1 \
    -reconnect_at_eof 1 \
    -reconnect_streamed 1 \
    -reconnect_delay_max 2 \
    -headers "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"$'\r\n'"Referer: https://live.sentinelgujarat.in/camera/${CAM_ID}"$'\r\n' \
    -i "https://live.sentinelgujarat.in/stream/${CAM_ID}" \
    -c:v libx264 \
    -preset ultrafast \
    -tune zerolatency \
    -g 25 \
    -keyint_min 25 \
    -pix_fmt yuv420p \
    -an \
    -f rtsp \
    "${RTSP_OUT}" &
  
  FFMPEG_PID=$!

  echo "✅ Camera ${CAM_ID} is now active at: ${RTSP_OUT}"
  read -r -p "Press [Enter] to switch camera..."
  cleanup
done
