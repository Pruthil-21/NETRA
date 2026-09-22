#!/usr/bin/env bash
# Shared across authentication and all camera supervisors in ONE relay.
# A 429 pauses the source, rather than triggering 30 independent reconnects.
gate_cooling() {
  local deadline=0
  [[ ! -s "$RUNTIME_DIR/cooldown" ]] || read -r deadline < "$RUNTIME_DIR/cooldown"
  (( deadline > $(date +%s) ))
}

gate_rate_limited() (
  flock -x 9 || exit 1
  local now deadline=0 previous=0 delay
  now=$(date +%s)
  [[ ! -s "$RUNTIME_DIR/cooldown" ]] || read -r deadline < "$RUNTIME_DIR/cooldown"
  # Concurrent errors belong to the same incident; don't extend it forever.
  (( deadline <= now )) || exit 0
  [[ ! -s "$RUNTIME_DIR/cooldown-delay" ]] || read -r previous < "$RUNTIME_DIR/cooldown-delay"
  delay=$(( previous > 0 ? previous * 2 : RATE_LIMIT_SECONDS ))
  (( delay <= MAX_RATE_LIMIT_SECONDS )) || delay=$MAX_RATE_LIMIT_SECONDS
  # Respect a server-supplied Retry-After delay, even above our fallback cap.
  if [[ "${1:-}" =~ ^[0-9]+$ ]] && (( 10#${1} > delay )); then delay=$((10#${1})); fi
  printf '%s\n' "$delay" > "$RUNTIME_DIR/cooldown-delay"
  printf '%s\n' "$((now + delay))" > "$RUNTIME_DIR/cooldown.tmp"
  mv "$RUNTIME_DIR/cooldown.tmp" "$RUNTIME_DIR/cooldown"
  printf '%s Organizer rate limit: pausing all upstream connections for %ss.\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$delay" >&2
) 9>"$RUNTIME_DIR/request.lock"

gate_slot() {
  local now next deadline wait_seconds
  while true; do
    # Lock only scheduling, never hold it during a wait or HTTP request.
    wait_seconds=$(
      exec 9>"$RUNTIME_DIR/request.lock"
      flock -x 9 || exit 1
      now=$(date +%s); next=0; deadline=0
      [[ ! -s "$RUNTIME_DIR/next-start" ]] || read -r next < "$RUNTIME_DIR/next-start"
      [[ ! -s "$RUNTIME_DIR/cooldown" ]] || read -r deadline < "$RUNTIME_DIR/cooldown"
      (( next >= deadline )) || next=$deadline
      if (( next <= now )); then
        printf '%s\n' "$((now + CONNECT_INTERVAL_SECONDS))" > "$RUNTIME_DIR/next-start"
        echo 0
      else
        echo "$((next - now))"
      fi
    )
    (( wait_seconds > 0 )) || return 0
    # Short sleeps allow shutdown and newly extended cooldowns to be noticed.
    (( wait_seconds <= 5 )) || wait_seconds=5
    sleep "$wait_seconds"
  done
}
