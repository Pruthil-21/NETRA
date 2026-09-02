#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/compose.recorded.yaml}"
EDGE_NODE_ID="${EDGE_NODE_ID:-edge-local-001}"
EXPECTED_CAMERAS="${EXPECTED_CAMERAS:-30}"
HLS_BASE_URL="${HLS_BASE_URL:-http://127.0.0.1:8888}"
REPORT_FILE="${REPORT_FILE:-/tmp/netra-streaming-evidence.md}"

if [[ ! "$EXPECTED_CAMERAS" =~ ^[0-9]+$ ]] ||
   (( EXPECTED_CAMERAS < 1 )); then
  echo "EXPECTED_CAMERAS must be a positive integer." >&2
  exit 1
fi

if ! docker compose -f "$COMPOSE_FILE" ps --status running replay \
  --format json >/dev/null 2>&1; then
  echo "The recorded replay stack is not running." >&2
  exit 1
fi

timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
publisher_count="$(docker top netra-replay | grep -c '[f]fmpeg' || true)"
replay_health="$(docker inspect --format '{{.State.Health.Status}}' \
  netra-replay 2>/dev/null || echo unavailable)"

working=0
failed=0
feed_results=""

for number in $(seq -w 1 "$EXPECTED_CAMERAS"); do
  url="$HLS_BASE_URL/stream/direct-cam${number}/index.m3u8?cookieCheck=1"
  code="$(curl -LsS -o /dev/null -w '%{http_code}' --max-time 15 \
    "$url" 2>/dev/null || true)"

  if [[ "$code" == "200" ]]; then
    working=$((working + 1))
  else
    failed=$((failed + 1))
  fi

  feed_results+="| direct-cam${number} | ${code:-FAILED} |"$'\n'
done

stats="$(docker stats --no-stream --format \
  '| {{.Name}} | {{.CPUPerc}} | {{.MemUsage}} | {{.MemPerc}} | {{.NetIO}} | {{.PIDs}} |' \
  netra-mediamtx netra-replay netra-cloudflared)"

public_base="$(docker compose -f "$COMPOSE_FILE" logs --no-color cloudflared \
  2>/dev/null | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | \
  tail -n 1 || true)"

result="FAIL"
if [[ "$publisher_count" == "$EXPECTED_CAMERAS" ]] &&
   [[ "$working" == "$EXPECTED_CAMERAS" ]] &&
   [[ "$replay_health" == "healthy" ]]; then
  result="PASS"
fi

{
  echo "# NETRA Streaming Evidence"
  echo
  echo "- Timestamp: \`$timestamp\`"
  echo "- Edge node: \`$EDGE_NODE_ID\`"
  echo "- Expected cameras: \`$EXPECTED_CAMERAS\`"
  echo "- FFmpeg publishers: \`$publisher_count\`"
  echo "- Working HLS feeds: \`$working\`"
  echo "- Failed HLS feeds: \`$failed\`"
  echo "- Replay health: \`$replay_health\`"
  echo "- Result: **$result**"
  echo "- Public base URL: \`${public_base:-not detected}\`"
  echo
  echo "## Container resources"
  echo
  echo "| Container | CPU | Memory | Memory % | Network I/O | PIDs |"
  echo "|---|---:|---:|---:|---:|---:|"
  echo "$stats"
  echo
  echo "## HLS availability"
  echo
  echo "| Stream | HTTP status |"
  echo "|---|---:|"
  printf '%s' "$feed_results"
  echo
  echo "## Scope statement"
  echo
  echo "NETRA validated $working concurrent prerecorded HLS streams on one "
  echo "containerized prototype edge node. This report does not represent "
  echo "80,000 simultaneous video streams."
} > "$REPORT_FILE"

echo "Evidence report: $REPORT_FILE"
echo "Publishers: $publisher_count"
echo "Working HLS feeds: $working"
echo "Failed HLS feeds: $failed"
echo "Replay health: $replay_health"
echo "Result: $result"

[[ "$result" == "PASS" ]]
