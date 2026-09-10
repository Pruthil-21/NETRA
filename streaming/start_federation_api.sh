#!/usr/bin/env bash
# Start the authenticated MediaMTX API on loopback and forward it only to the tailnet.
set -euo pipefail
cd "$(dirname "$0")"
[[ -s .env.federation-api.local ]] || { echo 'Missing .env.federation-api.local API credential file' >&2; exit 1; }
docker compose --env-file .env.federation-api.local -f compose.live.yaml -f compose.federation-api.yaml up -d --no-deps mediamtx
tailscale serve --bg --tcp=9997 tcp://127.0.0.1:9997
tailscale serve status
