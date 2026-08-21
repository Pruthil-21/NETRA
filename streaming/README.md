# NETRA — Streaming Module (P3)

Multi-protocol video streaming pipeline powered by MediaMTX and FFmpeg.

## Quickstart

1. **Install MediaMTX:**
   * Download the binary for your OS from [MediaMTX Releases](https://github.com/bluenviron/mediamtx/releases) into this directory.
   * Run `./mediamtx`

2. **Publish Video Feeds:**
   * **Simulated CCTV Loop:** `./start_file_feed.sh`
   * **Live Mac Webcam:** `./start_live_cam.sh`

---

## Endpoint Contract

| Target / Role | Protocol | Endpoint URL |
| :--- | :--- | :--- |
| **P4 (Dashboard UI)** | HLS Manifest (Camera 1) | `http://localhost:8888/camera1/index.m3u8` |
| **P4 (Dashboard UI)** | HLS Manifest (Livecam) | `http://localhost:8888/livecam/index.m3u8` |
| **P4 (Dashboard UI)** | WebRTC View | `http://localhost:8889/livecam` |
| **P5 (ANPR Analytics)** | RTSP Feed (Camera 1) | `rtsp://localhost:8554/camera1` |
| **P5 (ANPR Analytics)** | RTSP Feed (Livecam) | `rtsp://localhost:8554/livecam` |
