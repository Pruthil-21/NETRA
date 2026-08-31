#!/usr/bin/env bash
set -uo pipefail

cd "$(dirname "$0")/.."

PID_FILE=/tmp/netra-tunnels.pid

if [ -f "$PID_FILE" ]; then
  while read -r pid; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

# belt-and-suspenders: catch anything the pid file missed
pkill -f "venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000" 2>/dev/null
pkill -f "venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8001" 2>/dev/null
pkill -f "cloudflared tunnel --url http://localhost:8000" 2>/dev/null
pkill -f "cloudflared tunnel --url http://localhost:8001" 2>/dev/null

rm -f /tmp/netra-registry.pid /tmp/netra-watchlist.pid

echo "Stopped registry, watchlist, and tunnels. (Postgres left running: docker compose stop db to stop it too.)"
