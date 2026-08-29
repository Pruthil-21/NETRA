# NETRA Streaming

NETRA relays Gujarat organizer CCTV feeds through FFmpeg and MediaMTX for browser and ML consumption.

## One-command startup

Run `./start_streaming.sh`.

It starts:

- MediaMTX
- FFmpeg camera relays
- A Cloudflare Quick Tunnel

Keep the terminal running. Press `Control+C` to stop all services.

## Streaming pipeline

Organizer HLS → FFmpeg H.264 transcoding → MediaMTX RTSP → MediaMTX Low-Latency HLS → Cloudflare Tunnel → Frontend and ML consumers

Camera metadata is fetched from `https://live.corp8.cloud/api/cameras`.

The relay attempts every camera returned by the provider. Offline or broken feeds remain unavailable and retry automatically.

## Stream paths

- Local HLS: `http://localhost:8888/stream/{cameraId}/index.m3u8`
- Public HLS: `{cloudflareBaseUrl}/stream/{cameraId}/index.m3u8`
- Local RTSP for ML: `rtsp://localhost:8554/stream/{cameraId}`

## Run selected cameras manually

Start MediaMTX first, then run `./start_live_proxies.sh 6 13 16`.

With no camera IDs, the script attempts every camera returned by the provider.

## Low-latency settings

MediaMTX uses:

- `hlsVariant: lowLatency`
- `hlsSegmentCount: 7`
- `hlsSegmentDuration: 1s`
- `hlsPartDuration: 200ms`

Do not reduce `hlsSegmentCount` below `7`.

FFmpeg uses H.264, the `ultrafast` preset, `zerolatency` tuning and one-second forced keyframes.

## Logs

Runtime logs are stored in `streaming/logs/`.

Logs, generated certificates, PID files, the MediaMTX binary and downloaded MediaMTX archives are excluded from Git.

## Utility scripts

- `start_all_cameras.sh`: alias for the live proxy workflow
- `start_file_feed.sh`: isolated test-video publisher
- `start_live_cam.sh`: local Mac webcam publisher
- `rtsp_reader.py`: OpenCV RTSP reader for ANPR/ML testing

Cloudflare Quick Tunnel URLs change whenever the launcher restarts. Update frontend environment variables after receiving a new URL.
