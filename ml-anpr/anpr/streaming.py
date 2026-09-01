"""The three video-ingest entry points: live RTSP, a local file, and HLS.
Each wires up its own VehicleTracker and calls detect_plate_from_frame +
send_detection_to_watchlist -- kept as three near-duplicate loops (not
merged into one parameterized function) matching the source layout this
was extracted from; see ALPR_IMPROVEMENT_LOG.md for why each source type
needed its own read/reconnect handling."""
import os
import sys
import time
import uuid
from concurrent.futures import wait as _wait_futures
from datetime import datetime, timezone

import cv2

# Defensive re-insert (config.py already does this, but this module is
# sometimes reached before anything else has -- see config.py's own
# comment for why the repo root needs to be on sys.path here).
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from streaming.rtsp_reader import RTSPStreamReader

from .tracking import VehicleTracker
from .detection import detect_plate_from_frame
from .watchlist_client import send_detection_to_watchlist


def process_stream(rtsp_url, camera_id, process_every_n_frames=30, confirm_threshold=2, window_size=10):
    stream = RTSPStreamReader(rtsp_url=rtsp_url, inference_dim=(640, 360)).start()

    print(f"Connected to stream: {rtsp_url}")
    print("Press Ctrl+C to stop.\n")

    frame_count = 0
    # Session 7: one PlateConfirmationTracker per physical vehicle
    # track (via IoU association), not one shared globally -- see
    # VehicleTracker's docstring and ALPR_IMPROVEMENT_LOG.md Session 7.
    tracker = VehicleTracker(window_size=window_size, confirm_threshold=confirm_threshold)

    try:
        while True:
            ready, raw_frame, infer_frame = stream.read_latest()
            if not ready:
                continue

            frame_count += 1
            if frame_count % process_every_n_frames != 0:
                continue

            results = detect_plate_from_frame(infer_frame, raw_frame)

            for confirmed in tracker.update(results, raw_frame=raw_frame) + tracker.pop_ready_vlm_confirmations():
                event = {
                    "event_id": str(uuid.uuid4()),
                    "camera_id": camera_id,
                    "plate_number": confirmed["plate_number"],
                    "confidence": confirmed["confidence"],
                    "timestamp": datetime.now(timezone.utc).isoformat()
                }
                print(f"[CONFIRMED EVENT] {event} | {confirmed['note']}")
                # Contract (see contract/API_CONTRACT.md, confirmed directly
                # with P6): POST /detections is the single ingestion
                # endpoint for every confirmed plate read, not just
                # pattern-match-tier ones -- backend-watchlist itself
                # decides whether it's a watchlist hit server-side, so
                # gating client-side on note type here was under-reporting
                # real confirmed sightings (fallback-tier and vlm-fallback
                # reads were never being sent at all).
                send_detection_to_watchlist(confirmed["plate_number"], camera_id, confirmed["confidence"])

    except KeyboardInterrupt:
        print("\n\nStream stopped by user.")
        print(f"Total confirmed plates this session: {tracker.confirmed}")

    finally:
        stream.stop()


def process_video_file(video_path, camera_id, process_every_n_frames=15, confirm_threshold=2, window_size=10):
    """
    Same detection/confirmation logic as process_stream(), but reads from
    a local video file instead of a live RTSP source. Useful for repeatable
    testing without depending on live traffic being present.
    """
    cap = cv2.VideoCapture(video_path)

    if not cap.isOpened():
        print(f"Failed to open video file: {video_path}")
        return

    print(f"Reading from file: {video_path}\n")

    frame_count = 0
    # Session 7: one PlateConfirmationTracker per physical vehicle
    # track (via IoU association), not one shared globally -- see
    # VehicleTracker's docstring and ALPR_IMPROVEMENT_LOG.md Session 7.
    tracker = VehicleTracker(window_size=window_size, confirm_threshold=confirm_threshold)

    while True:
        ret, frame = cap.read()
        if not ret:
            print("End of video file")
            break

        frame_count += 1
        if frame_count % process_every_n_frames != 0:
            continue

        results = detect_plate_from_frame(frame, frame)
        for result in results:
            if result.get("plate_number"):
                print(f"[reading, frame {frame_count}] {result}")

        for confirmed in tracker.update(results, raw_frame=frame) + tracker.pop_ready_vlm_confirmations():
            event = {
                "event_id": str(uuid.uuid4()),
                "camera_id": camera_id,
                "plate_number": confirmed["plate_number"],
                "confidence": confirmed["confidence"],
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            print(f"[CONFIRMED EVENT] {event} | {confirmed['note']}")
    cap.release()

    # The video ends here, but a VLM fallback dispatched on one of the
    # last few frames may still be running in the background (see
    # tracking.VehicleTracker) -- give any still-pending calls a bounded
    # window to finish rather than silently dropping them from the final
    # count. 25s covers the measured worst case (6.7s cold-start) with
    # margin for a couple still in flight at once (max_workers=2).
    pending = tracker.pending_vlm_futures()
    if pending:
        _wait_futures(pending, timeout=25)
        for confirmed in tracker.pop_ready_vlm_confirmations():
            event = {
                "event_id": str(uuid.uuid4()),
                "camera_id": camera_id,
                "plate_number": confirmed["plate_number"],
                "confidence": confirmed["confidence"],
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            print(f"[CONFIRMED EVENT] {event} | {confirmed['note']}")

    print(f"\nTotal confirmed plates: {tracker.confirmed}")


def process_hls_stream(hls_url, camera_id, process_every_n_frames=15, confirm_threshold=2, window_size=10,
                        reconnect_interval_sec=2.0, max_open_attempts=10):
    """
    Same detection/confirmation logic as process_stream(), but for HLS
    sources (https://...m3u8) using plain cv2.VideoCapture, since
    RTSPStreamReader currently only supports rtsp:// URLs.

    Cloudflare quick tunnels (our current HLS source) are flaky by nature —
    both the initial open and individual frame reads can fail transiently.
    Retries with backoff instead of treating a single failure as fatal.
    """
    def _open():
        for attempt in range(1, max_open_attempts + 1):
            c = cv2.VideoCapture(hls_url)
            if c.isOpened():
                return c
            c.release()
            print(f"Failed to open stream (attempt {attempt}/{max_open_attempts}): {hls_url}")
            time.sleep(reconnect_interval_sec)
        return None

    cap = _open()
    if cap is None:
        print(f"Giving up on stream after {max_open_attempts} attempts: {hls_url}")
        return

    print(f"Connected to stream: {hls_url}")
    print("Press Ctrl+C to stop.\n")

    frame_count = 0
    # Session 7: one PlateConfirmationTracker per physical vehicle
    # track (via IoU association), not one shared globally -- see
    # VehicleTracker's docstring and ALPR_IMPROVEMENT_LOG.md Session 7.
    tracker = VehicleTracker(window_size=window_size, confirm_threshold=confirm_threshold)

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("Stream read failed, reconnecting...")
                cap.release()
                cap = _open()
                if cap is None:
                    print(f"Giving up on stream after {max_open_attempts} attempts: {hls_url}")
                    break
                continue

            frame_count += 1
            if frame_count % process_every_n_frames != 0:
                continue

            results = detect_plate_from_frame(frame, frame)

            for confirmed in tracker.update(results, raw_frame=frame) + tracker.pop_ready_vlm_confirmations():
                event = {
                    "event_id": str(uuid.uuid4()),
                    "camera_id": camera_id,
                    "plate_number": confirmed["plate_number"],
                    "confidence": confirmed["confidence"],
                    "timestamp": datetime.now(timezone.utc).isoformat()
                }
                print(f"[CONFIRMED EVENT] {event} | {confirmed['note']}")
                # See process_stream()'s matching comment: send every
                # confirmed read, not just pattern-match tier -- that's
                # what the contract actually asks for.
                send_detection_to_watchlist(confirmed["plate_number"], camera_id, confirmed["confidence"])

    except KeyboardInterrupt:
        print("\n\nStream stopped by user.")
        print(f"Total confirmed plates this session: {tracker.confirmed}")

    finally:
        cap.release()
