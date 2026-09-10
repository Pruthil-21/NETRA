#!/usr/bin/env bash
# Probe our local HLS origin; never follow arbitrary upstream playlist URLs.
set -Eeuo pipefail
url="$1"
state="$2"
stall_seconds="${3:-45}"
[[ "$stall_seconds" =~ ^[1-9][0-9]*$ ]] || exit 1
fetch() { curl -fsS --connect-timeout 2 --max-time 4 --max-filesize 262144 "$1"; }
playlist="$(fetch "$url")" || exit 1
[[ "$playlist" == '#EXTM3U'* ]] || exit 1
if [[ "$playlist" == *'#EXT-X-STREAM-INF:'* ]]; then
  child="$(printf '%s\n' "$playlist" | awk 'NF && $0 !~ /^#/ {sub(/\r$/, ""); print; exit}')"
  [[ "$child" =~ ^[A-Za-z0-9_-][A-Za-z0-9_./?=%\&-]*$ && "$child" != *'..'* ]] || exit 1
  playlist="$(fetch "${url%/*}/$child")" || exit 1
fi
[[ "$playlist" == '#EXTM3U'* ]] || exit 1
# Ignore LL-HLS startup gap placeholders; accept real completed media or parts.
media="$(printf '%s\n' "$playlist" | awk '
  /^#EXT-X-GAP/ {gap=1; next}
  /^#EXT-X-PART:/ {part=$0}
  NF && $0 !~ /^#/ {if (!gap) last=$0; gap=0}
  END {if (last!="") print last; else if (part!="") print part; else exit 1}')" || exit 1
sequence="$(printf '%s\n' "$playlist" | awk '/^#EXT-X-MEDIA-SEQUENCE:/ {print; exit}')"
fingerprint="$(printf '%s\n%s\n' "$sequence" "$media" | cksum)"
now="$(date +%s)"
previous=""
changed="$now"
if [[ -f "$state.progress" ]]; then
  IFS='|' read -r changed previous < "$state.progress" || true
fi
[[ "$changed" =~ ^[0-9]+$ ]] || changed="$now"
if [[ "$fingerprint" != "$previous" ]]; then
  changed="$now"
  printf '%s|%s\n' "$changed" "$fingerprint" > "$state.progress.tmp"
  mv "$state.progress.tmp" "$state.progress"
fi
(( now >= changed && now - changed <= stall_seconds )) || exit 1
printf '%s\n' "$now" > "$state.checked.tmp"
mv "$state.checked.tmp" "$state.checked"
