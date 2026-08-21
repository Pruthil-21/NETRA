# NETRA Video Streaming Infrastructure

This module handles video ingest, simulation, and RTSP relay for the NETRA pipeline (P4 Dashboard & P5 ANPR/ML).

## Architecture

- **Server**: MediaMTX listening on RTSP port `8554`.
- **Feed Switcher (`switch_camera.sh`)**: Interactive tool to dynamically route mock video feeds or configured stream URIs to `rtsp://localhost:8554/sentinel_cam`.
- **Hardware Ingest (`start_live_cam.sh`)**: Direct FaceTime HD Camera relay to `rtsp://localhost:8554/livecam`.
- **Mock Feed Loops (`start_file_feed.sh`)**: Loops local MP4 video fixtures for deterministic offline testing.

## Security & Configuration

- Remote camera endpoints are decoupled from the codebase and configured strictly via environment variables (`.env`).
- Insecure flags (`-tls_verify 0`) and hardcoded referer headers are stripped in favor of standard, authenticated transport pipelines.
- Local sample fixtures in `videos/` provide safe offline testing without external dependencies.
