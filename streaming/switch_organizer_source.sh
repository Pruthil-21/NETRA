#!/usr/bin/env bash
# Switch dashboard source only. Does not configure Archive or recording workers.
set -Eeuo pipefail
cd "$(dirname "$0")"
mode="${1:-}"
[[ "$mode" == replay || "$mode" == live ]] || { echo "Usage: $0 replay|live"; exit 2; }
lock=/tmp/digdhrishti-organizer-switch.lock
mkdir "$lock" 2>/dev/null || { echo "Another switch is in progress: $lock"; exit 1; }
trap 'rmdir "$lock"' EXIT
docker info >/dev/null
[[ $(docker inspect -f '{{.State.Running}}' netra-mediamtx) == true ]] || { echo 'Start MediaMTX first.'; exit 1; }
if [[ "$mode" == replay ]]; then
  dir="${ORGANIZER_ARCHIVE_DIR:-$HOME/Downloads/NETRA-organizer-archive}"
  for n in {1..30}; do printf -v id 'cam%02d' "$n"; [[ -s "$dir/$id.mp4" ]] || { echo "Missing $dir/$id.mp4"; exit 1; }; done
  docker update --restart=no netra-live-relay >/dev/null
  docker stop netra-live-relay >/dev/null
  CAMERA_LIMIT=30 docker compose --env-file "${STREAMING_ENV_FILE:-.env.federation-api.local}" -f compose.organizer-replay.yaml up -d --no-build --wait --wait-timeout 120 organizer-replay
  docker update --restart=unless-stopped netra-organizer-replay >/dev/null
  echo 'REPLAY: all 30 downloaded organizer videos. Archive configuration unchanged.'
else
  docker inspect netra-live-relay >/dev/null
  if docker inspect netra-organizer-replay >/dev/null 2>&1; then
    docker update --restart=no netra-organizer-replay >/dev/null
    docker stop netra-organizer-replay >/dev/null
  fi
  docker update --restart=unless-stopped netra-live-relay >/dev/null
  docker start netra-live-relay >/dev/null
  echo 'LIVE relay started. Actual feed availability depends on the organizer upstream.'
fi
