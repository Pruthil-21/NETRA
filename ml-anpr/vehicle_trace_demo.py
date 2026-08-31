"""
Vehicle-trace demo runner: scenario_run_id-tagged ANPR test against the
three staged RTSP streams (cameras 101/102/103) for the vehicle-trace demo.

Standalone script -- does NOT modify detect_plate.py, and lives on its own
throwaway branch (test/vehicle-trace-demo), never merged into Avi's branch,
per team policy on any ml-anpr change. It imports detect_plate and reuses
its real, unmodified detection pipeline (same YOLO model, same PaddleOCR
reader, same VehicleTracker/PlateConfirmationTracker clustering).

Known, load-bearing fact checked against detect_plate.py before writing
this: GX15OGJ is UK-format (2 letters + 2 digits + 3 letters, 7 chars).
INDIAN_PLATE_PATTERN requires 9-10 chars (2 letters + 2 digits + 1-2
letters + 4 digits), so this plate can never satisfy detect_plate.py's
strict "ok - pattern match" tier. It DOES qualify for the looser fallback
tier in _read_plate_from_box (6-12 chars, starts with 2 letters, has both
a digit and a letter) -- so a real OCR read of it will surface with note
"ok - fallback, unverified pattern", not "ok - pattern match". This script
treats that distinction as real signal, not noise: it reports whichever
tier actually fired, and by default only forwards true pattern-match
detections to the real backend -- fallback-tier reads are logged, not
silently upgraded into what would look like a confirmed ML detection.

Usage:
    python vehicle_trace_demo.py [--host 100.105.88.26] [--send-to-backend]

Defaults to logging every confirmed event (whichever tier) to
logs/vehicle_trace_demo_events.jsonl and printing it. Never POSTs to the
real backend-watchlist endpoint unless --send-to-backend is passed, and
even then only for "ok - pattern match" events unless --send-fallback-too
is also passed -- an unverified fallback read shouldn't silently become a
watchlist-visible detection.
"""

import argparse
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
import detect_plate  # noqa: E402 -- path insert above must run first

TARGET_PLATE = "GX15OGJ"
SOURCE_TAG = "vehicle-trace-demo"
CAMERAS = [101, 102, 103]

# Same threshold detect_plate.py's own PlateConfirmationTracker uses to
# cluster candidate reads of the same physical plate (SIMILARITY_THRESHOLD,
# see _plate_similarity) -- reused here so "is this our target vehicle" is
# judged by the same, already-tuned tolerance for OCR noise (0/O, 1/I, a
# missing/extra character), not an arbitrarily different one.
TARGET_MATCH_THRESHOLD = 0.7

# Overridable via env so this can point at the real backend-watchlist
# tunnel + real X-Internal-Key once P6 confirms them, without touching
# detect_plate.py's own (placeholder) DETECTION_API_URL/INTERNAL_KEY.
DETECTION_API_URL = os.environ.get("VEHICLE_TRACE_DETECTION_API_URL", detect_plate.DETECTION_API_URL)
INTERNAL_KEY = os.environ.get("VEHICLE_TRACE_INTERNAL_KEY", detect_plate.INTERNAL_KEY)

LOG_PATH = os.path.join(os.path.dirname(__file__), "logs", "vehicle_trace_demo_events.jsonl")

# Single-threaded, round-robin across all three streams (not one thread per
# camera): yolo_model/ocr_reader are shared, single instances -- concurrent
# calls into them from multiple threads is an untested, likely-unsafe path
# for paddle's inference session. Round-robin keeps every model call on one
# thread while still servicing all three cameras, at the cost of slightly
# lower per-camera frame rate -- acceptable for a demo, not for production.
_raw_ocr_buffer = []
_original_ocr_readtext = detect_plate._ocr_readtext


def _recording_ocr_readtext(img):
    """Wraps detect_plate._ocr_readtext (monkeypatched at import time, the
    tracked file itself is never edited) to additionally capture the raw,
    pre-correction/pre-regex/pre-fallback-tier text+confidence PaddleOCR
    actually returned -- the "raw OCR result before applying any fallback"
    the demo brief asks for. Behavior/return value is unchanged."""
    results = _original_ocr_readtext(img)  # list of (bbox, text, conf) -- possibly empty
    for _, raw_text, raw_conf in results:
        if raw_text:
            _raw_ocr_buffer.append({"raw_text": raw_text, "raw_confidence": raw_conf})
    return results


detect_plate._ocr_readtext = _recording_ocr_readtext


def normalize_plate(text):
    """Strip spaces/punctuation, uppercase -- the demo's own normalization,
    independent of detect_plate's Indian-format regex. Used to decide
    "did we actually see GX15OGJ", not to decide whether detect_plate's own
    pattern-match gate fired (that's a separate, honestly-reported field)."""
    return "".join(ch for ch in (text or "").upper() if ch.isalnum())


def _load_already_emitted(scenario_run_id):
    """One event per camera per scenario_run_id, even across a restart --
    the demo clips loop continuously, so without this a long-running or
    re-run process would re-emit the same camera's detection repeatedly."""
    emitted = set()
    if not os.path.exists(LOG_PATH):
        return emitted
    with open(LOG_PATH, "r", encoding="utf-8") as f:
        for line in f:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("scenario_run_id") == scenario_run_id:
                emitted.add(row["camera_id"])
    return emitted


def _append_log(event):
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(event) + "\n")


def _try_send_to_backend(event):
    """Best-effort POST to backend-watchlist's POST /detections, extended
    per Anushka's vehicle-trace contract (detected_at, scenario_run_id,
    source added on top of the base camera_id/plate_number/confidence body
    -- contract/API_CONTRACT.md's original fields). Resending the same
    (scenario_run_id, camera_id, plate_number) is documented server-side as
    a safe no-op, so the looping demo clips re-triggering this isn't a
    duplicate-creation risk even without this script's own per-run dedup.
    Never raises; a failure just means the event stays log-only, which is
    always written regardless of this outcome."""
    import requests

    body = {
        "camera_id": event["camera_id"],
        "plate_number": event["plate_number"],
        "confidence": event["confidence"],
        "detected_at": event["detected_at"],
        "scenario_run_id": event["scenario_run_id"],
        "source": event["source"],
    }
    try:
        resp = requests.post(
            DETECTION_API_URL,
            json=body,
            headers={"X-Internal-Key": INTERNAL_KEY},
            timeout=3,
        )
        if resp.status_code == 201:
            return True, resp.json()
        return False, f"HTTP {resp.status_code}: {resp.text}"
    except Exception as exc:  # noqa: BLE001 -- network/requests errors, all non-fatal here
        return False, str(exc)


class CameraSlot:
    def __init__(self, camera_id, rtsp_url):
        self.camera_id = camera_id
        self.rtsp_url = rtsp_url
        self.stream = None
        self.tracker = detect_plate.VehicleTracker(window_size=10, confirm_threshold=2)
        self.frame_count = 0
        self.connect_error = None

    def connect(self):
        try:
            self.stream = detect_plate.RTSPStreamReader(
                rtsp_url=self.rtsp_url, inference_dim=(640, 360)
            ).start()
            print(f"[camera {self.camera_id}] connected: {self.rtsp_url}")
        except Exception as exc:  # noqa: BLE001
            self.connect_error = str(exc)
            print(f"[camera {self.camera_id}] FAILED to connect: {exc}")

    def close(self):
        if self.stream is not None:
            self.stream.stop()


def target_match_score(plate_text):
    """Fuzzy similarity (0-1) between a normalized candidate plate and the
    normalized target plate, via detect_plate's own _plate_similarity --
    the same tolerance it already uses to cluster noisy OCR reads of one
    physical plate, applied here to judge "is this our target vehicle"."""
    return detect_plate._plate_similarity(normalize_plate(plate_text), normalize_plate(TARGET_PLATE))


def build_event(camera_id, scenario_run_id, confirmed, raw_reads_this_frame):
    plate_text = confirmed["plate_number"] or ""
    plate_norm = normalize_plate(plate_text)
    target_norm = normalize_plate(TARGET_PLATE)
    similarity = target_match_score(plate_text)

    return {
        "event_id": str(uuid.uuid4()),
        "scenario_run_id": scenario_run_id,
        "camera_id": camera_id,
        # Both keys populated with the same value -- the two handoff
        # messages for this demo used "plate_number" and "plate"
        # respectively; contract/API_CONTRACT.md's real POST /detections
        # body only has "plate_number", so that's what actually gets sent.
        "plate_number": plate_text,
        "plate": plate_text,
        "plate_normalized": plate_norm,
        "target_plate": TARGET_PLATE,
        "matched_target": plate_norm == target_norm,
        "target_match_score": round(similarity, 3),
        "confidence": confirmed["confidence"],
        "match_tier": confirmed["note"],  # "ok - pattern match" | "ok - fallback, unverified pattern"
        "raw_ocr_reads": raw_reads_this_frame,
        "detected_at": datetime.now(timezone.utc).isoformat(),
        "source": SOURCE_TAG,
    }


def run(host, scenario_run_id, process_every_n_frames, send_to_backend, send_fallback_too):
    emitted = _load_already_emitted(scenario_run_id)
    if emitted:
        print(f"[info] already emitted for cameras {sorted(emitted)} in run {scenario_run_id} -- skipping those")

    slots = [CameraSlot(cam_id, f"rtsp://{host}:8554/stream/{cam_id}") for cam_id in CAMERAS]
    for slot in slots:
        slot.connect()

    active = [s for s in slots if s.stream is not None]
    if not active:
        print("[error] no camera streams connected -- nothing to process.")
        return

    print(f"[info] processing {len(active)}/{len(slots)} streams for scenario_run_id={scenario_run_id}. Ctrl+C to stop.")

    try:
        while any(s.camera_id not in emitted for s in active):
            for slot in active:
                if slot.camera_id in emitted:
                    continue

                ready, raw_frame, infer_frame = slot.stream.read_latest()
                if not ready:
                    continue

                slot.frame_count += 1
                if slot.frame_count % process_every_n_frames != 0:
                    continue

                del _raw_ocr_buffer[:]
                results = detect_plate.detect_plate_from_frame(infer_frame, raw_frame)
                raw_reads_this_frame = list(_raw_ocr_buffer)

                for confirmed in slot.tracker.update(results):
                    event = build_event(slot.camera_id, scenario_run_id, confirmed, raw_reads_this_frame)

                    if event["target_match_score"] < TARGET_MATCH_THRESHOLD:
                        # A different, nearby vehicle's plate confirmed first --
                        # a busy multi-lane scene doesn't guarantee the first
                        # plate to stabilize is the one we're tracing. Keep
                        # scanning this camera instead of locking onto it.
                        print(f"[camera {slot.camera_id}] rejected (not target, score="
                              f"{event['target_match_score']}): {event['plate_number']}")
                        continue

                    should_send = send_to_backend and (
                        event["match_tier"] == "ok - pattern match" or send_fallback_too
                    )
                    if should_send:
                        sent, detail = _try_send_to_backend(event)
                    else:
                        sent, detail = False, "not attempted (fallback-tier read, --send-fallback-too not set)" \
                            if send_to_backend else "not attempted (--send-to-backend not set)"
                    event["sent_to_backend"] = sent
                    event["backend_detail"] = detail

                    _append_log(event)
                    emitted.add(slot.camera_id)

                    print(f"[camera {slot.camera_id}] CONFIRMED ({event['match_tier']}) -> logged to {LOG_PATH}")
                    print(json.dumps(event, indent=2))
                    break  # one confirmed *target* event per camera per scenario run
    except KeyboardInterrupt:
        print("\nStopped by user.")
    finally:
        for slot in active:
            slot.close()

    still_missing = [s.camera_id for s in slots if s.camera_id not in emitted]
    if still_missing:
        print(f"[info] no confirmed detection this run for camera(s): {still_missing}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--host",
        default=os.environ.get("VEHICLE_TRACE_RTSP_HOST", "100.105.88.26"),
        help="RTSP host: 100.105.88.26 over Tailscale (default), or 127.0.0.1 if running on Dhruv's Mac directly.",
    )
    parser.add_argument("--scenario-run-id", default="49881ca6-2e18-4f4b-90e4-bbeaee2c7663")
    parser.add_argument("--process-every-n-frames", type=int, default=10)
    parser.add_argument(
        "--send-to-backend",
        action="store_true",
        help="POST confirmed pattern-match events to the real backend-watchlist endpoint. "
             "Off by default -- every event is always logged locally regardless of this flag.",
    )
    parser.add_argument(
        "--send-fallback-too",
        action="store_true",
        help="Also send fallback-tier (unverified pattern) events to the backend. Off by default -- "
             "GX15OGJ is expected to land in the fallback tier (UK format), and an unverified read "
             "shouldn't silently look like a confirmed ML detection in a shared table.",
    )
    args = parser.parse_args()

    run(
        host=args.host,
        scenario_run_id=args.scenario_run_id,
        process_every_n_frames=args.process_every_n_frames,
        send_to_backend=args.send_to_backend,
        send_fallback_too=args.send_fallback_too,
    )


if __name__ == "__main__":
    main()
