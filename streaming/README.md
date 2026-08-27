# Streaming

Live workflow: `start_live_proxies.sh` fetches `https://live.corp8.cloud/api/cameras`, selects cameras with `width > 0`, pulls each camera's public HLS feed, transcodes video to H.264/AVC with FFmpeg, and publishes it to local MediaMTX as `stream/<camera-id>`.

Start MediaMTX first, then run:

```bash
./start_live_proxies.sh
```

To run only confirmed active camera IDs, pass them explicitly:

```bash
./start_live_proxies.sh 6 13 16
```

The local HLS playlist is `http://localhost:8888/stream/<camera-id>/index.m3u8`. `start_all_cameras.sh` is retained as an alias for the live workflow. The separate `start_file_feed.sh` remains available only for isolated test-video troubleshooting.
