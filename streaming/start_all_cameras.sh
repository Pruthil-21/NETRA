#!/bin/bash

# Array of camera IDs from 1 to 31
CAMERAS=({1..31})

# Function to run a persistent stream loop for an individual camera
stream_camera() {
  local CAM_ID=$1
  local RTSP_OUT="rtsp://localhost:8554/sentinel_cam${CAM_ID}"

  while true; do
    OFFSET=$(curl -s "https://live.sentinelgujarat.in/api/cameras/${CAM_ID}/state" | grep -o '"offset":[0-9.]*' | cut -d: -f2 | cut -d. -f1)
    
    if [ -z "$OFFSET" ]; then
      OFFSET=9300
    fi

    ffmpeg -re -nostdin -loglevel error \
      -headers "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"$'\r\n'"Referer: https://live.sentinelgujarat.in/camera/${CAM_ID}"$'\r\n' \
      -ss "$OFFSET" \
      -i "https://live.sentinelgujarat.in/stream/${CAM_ID}" \
      -c:v copy \
      -an -f rtsp "$RTSP_OUT"

    sleep 1
  done
}

echo "Starting RTSP broadcast for all 31 Sentinel Gujarat cameras..."

# Trap SIGINT and SIGTERM to kill all spawned background processes cleanly
cleanup() {
  echo -e "\nStopping all camera streams..."
  kill $(jobs -p) 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

# Launch each camera streamer in the background
for CAM in "${CAMERAS[@]}"; do
  echo "  -> Initializing Camera $CAM on rtsp://localhost:8554/sentinel_cam${CAM}"
  stream_camera "$CAM" &
done

echo "All 31 cameras launched in the background. Press Ctrl+C to stop all streams."

# Keep main script alive
wait
