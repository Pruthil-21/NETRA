#!/usr/bin/env bash
# ==============================================================================
# NETRA Dynamic Stream Switcher
# Ingests configurable local or remote video feeds into MediaMTX RTSP for ANPR/ML.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RTSP_PORT="${RTSP_PORT:-8554}"
RTSP_PATH="${RTSP_PATH:-sentinel_cam}"
RTSP_OUT="rtsp://localhost:${RTSP_PORT}/${RTSP_PATH}"
VIDEOS_DIR="${SCRIPT_DIR}/videos"
FFMPEG_PID=""

# Load optional environment configuration if present
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/.env"
fi

cleanup() {
  if [[ -n "${FFMPEG_PID}" ]] && kill -0 "${FFMPEG_PID}" 2>/dev/null; then
    kill -9 "${FFMPEG_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "----------------------------------------------------"
echo "  NETRA Multi-Feed RTSP Broadcaster                 "
echo "  Target Output: ${RTSP_OUT}                         "
echo "----------------------------------------------------"

while true; do
  echo ""
  echo "Available Modes / Camera Feeds:"
  echo "  1) Local Test Video Loop (Default Sample)"
  echo "  2) Local Video (camera_feed_1.mp4)"
  echo "  3) Custom Stream URI (configured via REMOTE_STREAM_URL / custom input)"
  read -r -p "Select feed [1-3, or 'q' to quit]: " SELECTION

  if [[ "${SELECTION}" =~ ^[qQ]$ ]]; then
    echo "Shutting down stream relay..."
    cleanup
    break
  fi

  INPUT_SOURCE=""
  EXTRA_FLAGS=()

  case "${SELECTION}" in
    1)
      INPUT_SOURCE="${VIDEOS_DIR}/test_feed.mp4"
      EXTRA_FLAGS=(-stream_loop -1 -re)
      ;;
    2)
      INPUT_SOURCE="${VIDEOS_DIR}/camera_feed_1.mp4"
      EXTRA_FLAGS=(-stream_loop -1 -re)
      ;;
    3)
      if [[ -n "${REMOTE_STREAM_URL:-}" ]]; then
        INPUT_SOURCE="${REMOTE_STREAM_URL}"
      else
        read -r -p "Enter custom stream URL (RTSP/HLS/HTTP): " INPUT_SOURCE
      fi
      EXTRA_FLAGS=(-re)
      ;;
    *)
      echo "⚠️ Invalid selection. Please enter 1, 2, 3, or q."
      continue
      ;;
  esac

  cleanup

  echo "Initializing stream source: ${INPUT_SOURCE}..."

  ffmpeg \
    -nostdin \
    -loglevel warning \
    "${EXTRA_FLAGS[@]}" \
    -i "${INPUT_SOURCE}" \
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

  echo "✅ Active stream publishing to: ${RTSP_OUT}"
  read -r -p "Press [Enter] to switch feed..."
  cleanup
done
