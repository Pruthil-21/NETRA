#!/usr/bin/env bash
# Run in the relay image with bash; no real upstream requests or credentials.
set -Eeuo pipefail
RUNTIME_DIR=$(mktemp -d)
trap 'rm -rf "$RUNTIME_DIR"' EXIT
RATE_LIMIT_SECONDS=2
MAX_RATE_LIMIT_SECONDS=8
CONNECT_INTERVAL_SECONDS=1
source /usr/local/bin/organizer-request-gate.sh
gate_rate_limited
gate_cooling
first=$(cat "$RUNTIME_DIR/cooldown")
gate_rate_limited
[[ $(cat "$RUNTIME_DIR/cooldown") == "$first" ]]
echo 0 > "$RUNTIME_DIR/cooldown"
gate_rate_limited
[[ $(cat "$RUNTIME_DIR/cooldown-delay") == 4 ]]
echo 0 > "$RUNTIME_DIR/cooldown"
gate_rate_limited 20
[[ $(cat "$RUNTIME_DIR/cooldown-delay") == 20 ]]
echo "$(( $(date +%s) + 2 ))" > "$RUNTIME_DIR/cooldown"
start=$(date +%s)
gate_slot
(( $(date +%s) - start >= 2 ))
start=$(date +%s)
gate_slot
(( $(date +%s) - start >= 1 ))
for n in 1 2 3; do
  (gate_slot; date +%s > "$RUNTIME_DIR/slot-$n") &
done
wait
mapfile -t slots < <(cat "$RUNTIME_DIR"/slot-* | sort -n)
(( slots[1] - slots[0] >= 1 && slots[2] - slots[1] >= 1 ))
echo 'PASS: cooldown coalescing, exponential delay, Retry-After, and connection pacing'
