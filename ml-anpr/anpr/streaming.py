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
from urllib.parse import urljoin

import cv2
import requests

# Defensive re-insert (config.py already does this, but this module is
# sometimes reached before anything else has -- see config.py's own
# comment for why the repo root needs to be on sys.path here).
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from streaming.rtsp_reader import RTSPStreamReader

from .tracking import VehicleTracker
from .detection import detect_plate_from_frame
from .watchlist_client import send_detection_to_watchlist


def _print_summary(tracker, label="Total confirmed plates"):
    """Shared end-of-run stats print (vehicles tracked, plate candidates
    read, confirmed plates broken down by tier) -- used by all three
    entry points so the presentation-ready numbers are consistent
    regardless of which one a run used."""
    print(f"\nVehicles tracked: {tracker.total_vehicles_tracked}")
    print(f"Plate candidates read: {tracker.total_plate_candidates}")
    print(f"Confirmed plates by tier: {tracker.confirmed_by_tier}")
    print(f"{label}: {tracker.confirmed_plates}")


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
        _print_summary(tracker, label="Total confirmed plates this session")

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

    _print_summary(tracker)


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
    def _resolve_master_playlist(url):
        """MediaMTX (our live relay's HLS server) mints a brand-new session
        ID on every GET of a master playlist -- confirmed directly: three
        back-to-back curls of the same index.m3u8 URL each returned a
        different `?session=...` variant-playlist reference. OpenCV's
        FFmpeg backend issues more than one request while opening a
        stream, so passing it the raw master URL means later reads can
        land on a superseded session -- this is what caused every direct
        cv2.VideoCapture(master_url) attempt to hang for the full 30s
        ffmpeg stream-timeout and fail (see ALPR_IMPROVEMENT_LOG.md
        Session 23, live cam06 test against P3's relay).

        Fetching the master once ourselves and handing FFmpeg the
        resolved, already session-scoped variant URL avoids the repeated
        re-probing/session-mismatch entirely -- verified this reconnects
        cleanly for multiple opens on the same resolved URL, not just the
        first one. Falls back to the original URL unchanged if this
        doesn't look like a master playlist (e.g. `url` is already a
        variant playlist, or the resolve request itself fails) -- safe
        for any plain HLS source with no master/variant split.
        """
        try:
            resp = requests.get(url, timeout=10)
            resp.raise_for_status()
            lines = [ln.strip() for ln in resp.text.splitlines() if ln.strip() and not ln.startswith("#")]
            if lines and lines[0].split("?")[0].endswith(".m3u8"):
                return urljoin(url, lines[0])
        except requests.exceptions.RequestException:
            pass
        return url

    def _open():
        for attempt in range(1, max_open_attempts + 1):
            resolved_url = _resolve_master_playlist(hls_url)
            c = cv2.VideoCapture(resolved_url)
            if c.isOpened():
                return c
            c.release()
            print(f"Failed to open stream (attempt {attempt}/{max_open_attempts}): {hls_url}")
            if attempt < max_open_attempts:
                # Real exponential backoff (was a flat reconnect_interval_sec
                # delay before, despite this function's own docstring already
                # saying "backoff") -- same doubling pattern EventSender
                # already uses, capped so max_open_attempts=10 can't add up
                # to an absurd total wait. Covers P3's ask to back off on a
                # missing/timed-out/404 camera rather than hammer it.
                delay = min(reconnect_interval_sec * (2 ** (attempt - 1)), 30.0)
                time.sleep(delay)
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
        _print_summary(tracker, label="Total confirmed plates this session")

    finally:
        cap.release()
