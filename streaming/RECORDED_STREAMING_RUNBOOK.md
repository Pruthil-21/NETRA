# NETRA Recorded Streaming Runbook

## Scope

This runbook operates the containerized NETRA recorded-camera demonstration.
One stack represents one prototype edge-media node running MediaMTX, FFmpeg
replay publishers, and a Cloudflare Quick Tunnel.

## Verified capacity

- 30 concurrent prerecorded publishers
- 30 working local HLS feeds
- End-to-end replay health check
- Configurable CPU and memory limits

This is not evidence of 80,000 simultaneous video streams. The proposed
80,000-camera design distributes registered cameras across many edge nodes.
Per-node capacity must be established through hardware-specific benchmarks.

## Prerequisites

- Docker Desktop with Docker Compose
- NETRA repository checked out locally
- Recordings named `cam01.mp4` through `cam30.mp4`
- Recordings stored in `~/Downloads/NETRA-organizer-archive`

Recordings are mounted read-only and are not stored in the repository.

## Start the stack

From the repository root:

```bash
EDGE_NODE_ID=edge-local-001 CAMERA_LIMIT=30 docker compose \
  -f streaming/compose.recorded.yaml \
  up -d --build
```

## Check service status

```bash
docker compose \
  -f streaming/compose.recorded.yaml \
  ps
```

The replay service should report `healthy`.

## Stream URLs

Local HLS URL pattern:

```text
http://127.0.0.1:8888/stream/direct-camXX/index.m3u8
```

Retrieve the current temporary public base URL:

```bash
docker compose \
  -f streaming/compose.recorded.yaml \
  logs --no-color cloudflared | \
  grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | \
  tail -n 1
```

## Generate scalability evidence

```bash
EDGE_NODE_ID=edge-local-001 \
EXPECTED_CAMERAS=30 \
REPORT_FILE=/tmp/netra-streaming-evidence.md \
./streaming/benchmark_recorded_stack.sh
```

The command succeeds only when the publisher count, HLS success count, and
expected camera count match and the replay container is healthy.

## Logs

```bash
docker compose \
  -f streaming/compose.recorded.yaml \
  logs --tail=100 replay mediamtx cloudflared
```

## Restart replay publishers

```bash
EDGE_NODE_ID=edge-local-001 CAMERA_LIMIT=30 docker compose \
  -f streaming/compose.recorded.yaml \
  up -d --force-recreate replay
```

## Stop the stack

```bash
docker compose \
  -f streaming/compose.recorded.yaml \
  down
```

## Troubleshooting

- An initial HLS `302` is the normal MediaMTX cookie-check redirect. Follow
  redirects and preserve cookies when testing with curl.
- A temporary `404` can occur while a publisher or HLS muxer initializes.
- If replay becomes unhealthy, inspect replay and MediaMTX logs first.
- If a publisher repeatedly exits, verify the corresponding recording with
  `ffprobe` and check whether that camera requires transcoding.
- The Cloudflare Quick Tunnel URL changes whenever its container is recreated.

## Horizontal scaling model

Each deployed edge node receives a unique `EDGE_NODE_ID` and an assigned camera
set. Compatible H.264 feeds are remuxed, while incompatible feeds are
transcoded. Central services store camera metadata and detections; they do not
pull every video continuously. Playback is requested from the responsible edge
node only when needed.

The planning example of 800 nodes with 100 registered cameras per node explains
how 80,000 camera identities can be partitioned. The verified prototype result
remains 30 concurrent streams on the tested edge node.
