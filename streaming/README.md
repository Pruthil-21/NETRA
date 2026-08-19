# Streaming

Simulates department CCTV feeds for the prototype: FFmpeg loops a sample video into RTSP, ingested by MediaMTX, which re-serves the same ingest as HLS (scalable, public dashboard) and WebRTC (low-latency, authorized viewers).

Feed URLs are consumed by `frontend-dashboard/`.
