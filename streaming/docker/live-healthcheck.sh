#!/usr/bin/env sh
# Authentication freshness and recent successful advancing-playlist probes.
set -eu
runtime="${RUNTIME_DIR:-/tmp/netra-live}"
test -s "$runtime/auth-success"
test -s "$runtime/cameras.json"
age=$(( $(date +%s) - $(cat "$runtime/auth-success") ))
test "$age" -ge 0
test "$age" -le "$(( ${AUTH_REFRESH_SECONDS:-600} + 240 ))"
online=0
required="${MIN_ONLINE_CAMERAS:-1}"
case "$required" in ''|*[!0-9]*) exit 1;; esac
test "$required" -gt 0
now=$(date +%s)
for status in "$runtime"/status/cam[0-9]*; do
  test -f "$status" || continue
  case "$status" in *.checked|*.progress|*.tmp) continue;; esac
  test "$(cat "$status")" = online || continue
  test -s "$status.checked" || continue
  checked=$(cat "$status.checked")
  case "$checked" in ''|*[!0-9]*) continue;; esac
  test "$now" -ge "$checked" || continue
  test "$((now - checked))" -le 30 || continue
  online=$((online + 1))
done
test "$online" -ge "$required"
