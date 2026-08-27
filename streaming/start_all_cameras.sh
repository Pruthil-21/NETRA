#!/usr/bin/env bash
# Backwards-compatible entry point for the live provider workflow.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$DIR/start_live_proxies.sh" "$@"
