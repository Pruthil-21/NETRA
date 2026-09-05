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

## Recorded footage / VOD playback

MediaMTX records every live path to disk (`record: true`, 10-minute fMP4
segments, 7-day retention -- see `mediamtx.yml`'s per-path Record settings)
and serves them back through its own Playback API (`playback: true`, port
`9996`):

- `GET /list?path={cameraId}` -- available recorded segments for a camera
  (start time + duration each). `backend-registry`'s `recordings_service`
  proxies this as `GET /cameras/{id}/recordings`, since only the backend
  knows the camera-id -> MediaMTX-path (`stream_id`) mapping.
- `GET /get?path={cameraId}&start={RFC3339}&duration={seconds}&format=mp4`
  -- streams (and, with a `download` link, exports) an arbitrary clip range,
  concatenating segments as needed. The frontend hits this directly (same
  as it already does for live HLS via `NEXT_PUBLIC_MEDIAMTX_HLS_URL`) using
  `NEXT_PUBLIC_MEDIAMTX_PLAYBACK_URL`, rather than proxying video bytes
  through the backend.

Nothing is recorded for a camera until it has been read live at least once
after the stack starts (MediaMTX only records while a path is active).

## Utility scripts

- `start_all_cameras.sh`: alias for the live proxy workflow
- `start_file_feed.sh`: isolated test-video publisher
- `start_live_cam.sh`: local Mac webcam publisher
- `rtsp_reader.py`: OpenCV RTSP reader for ANPR/ML testing

Cloudflare Quick Tunnel URLs change whenever the launcher restarts. Update frontend environment variables after receiving a new URL.
