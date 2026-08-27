import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone

import cv2
import torch
import requests
from ultralytics import YOLO
import easyocr

# Allow importing streaming/rtsp_reader.py even when running from inside
# ml-anpr/ — adds the repo root to the path so `streaming` is importable.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from streaming.rtsp_reader import RTSPStreamReader

# ---------------------------------------------------------------------------
# CONFIRM WITH P6 BEFORE DEMO:
# 1. Exact endpoint path (/alerts vs /detections)
# 2. Real value for X-Internal-Key
# 3. Numeric camera_id mapping (P6's DetectionIn expects an int, but our
#    RTSP paths are named "livecam" / "camera1" — map them here)
# ---------------------------------------------------------------------------
ALERT_API_URL = "http://192.168.31.11:8001/alerts"
INTERNAL_KEY = "dev-internal-key"
CAMERA_ID_MAP = {
    "livecam": 1,
    "camera1": 1,
    "camera16": 16,
}

if torch.backends.mps.is_available():
    device = "mps"
elif torch.cuda.is_available():
    device = "cuda"
else:
    device = "cpu"

print(f"Using device: {device}")

yolo_model = YOLO("yolov8n.pt")
yolo_model.to(device)

ocr_reader = easyocr.Reader(['en'], gpu=False)

INDIAN_PLATE_PATTERN = re.compile(r'^[A-Z]{2}[0-9]{2}[A-Z]{1,2}[0-9]{4}$')


def _plate_similarity(a, b):
    """Fraction of matching characters at the same position. Only meaningful
    for equal-length strings, since motion blur/distance mostly causes
    per-character substitution errors (e.g. 8 <-> B), not length changes."""
    if len(a) != len(b):
        return 0.0
    matches = sum(1 for x, y in zip(a, b) if x == y)
    return matches / len(a)


class PlateConfirmationTracker:
    """
    Real dashcam footage never OCR's the same plate to an identical string
    frame-to-frame (e.g. HR9BE4959 / HR98E4959 / HR9854952 for one real
    plate) — motion blur causes per-character substitution errors that
    drift the exact string every read, so exact-match confirmation never
    fires. This clusters same-length readings that are "close enough" to
    be the same plate, and reconstructs the most likely plate via
    confidence-weighted per-character voting across the cluster, instead
    of requiring an exact repeated string.

    Individual low-confidence readings are still worth clustering — a
    single 0.15-confidence read of a real plate is noise on its own, but
    several of them voting together can reconstruct a confident plate. So
    every OCR-filtered candidate is fed in regardless of its own
    confidence; the per-note confidence floor is only enforced against the
    cluster's peak confidence at confirmation time.
    """
    SIMILARITY_THRESHOLD = 0.7

    def __init__(self, window_size=10, confirm_threshold=2):
        self.window_size = window_size
        self.confirm_threshold = confirm_threshold
        self.clusters = []
        self.confirmed = set()

    def _find_cluster(self, plate):
        best_cluster, best_score = None, 0.0
        for cluster in self.clusters:
            score = _plate_similarity(cluster["representative"], plate)
            if score >= self.SIMILARITY_THRESHOLD and score > best_score:
                best_cluster, best_score = cluster, score
        return best_cluster

    # A raw reading that already matched the strict Indian-plate structure
    # on its own is much stronger evidence per character than a handful of
    # low-confidence fallback-tier misreads — without this, several noisy
    # "close enough" misreads can outvote a couple of genuinely correct
    # structural matches.
    PATTERN_MATCH_VOTE_WEIGHT = 2.5

    @classmethod
    def _reconstruct(cls, readings):
        length = len(readings[0][0])
        chars = []
        for i in range(length):
            votes = {}
            for plate, conf, note in readings:
                weight = conf * (cls.PATTERN_MATCH_VOTE_WEIGHT if note == "ok - pattern match" else 1.0)
                votes[plate[i]] = votes.get(plate[i], 0.0) + weight
            chars.append(max(votes, key=votes.get))
        return "".join(chars)

    def add(self, plate, confidence, note):
        """Feed one OCR-filtered reading in (any confidence). Returns a
        confirmed-event dict the first time a cluster crosses
        confirm_threshold AND its peak confidence clears the floor for its
        reconstructed note type, else None."""
        cluster = self._find_cluster(plate)
        if cluster is None:
            cluster = {"readings": [], "representative": plate}
            self.clusters.append(cluster)
            self.clusters = self.clusters[-20:]

        cluster["readings"].append((plate, confidence, note))
        cluster["readings"] = cluster["readings"][-self.window_size:]
        cluster["representative"] = self._reconstruct(cluster["readings"])

        if len(cluster["readings"]) < self.confirm_threshold or cluster["representative"] in self.confirmed:
            return None

        best_conf = max(c for _, c, _ in cluster["readings"])
        reconstructed_note = "ok - pattern match" if INDIAN_PLATE_PATTERN.match(cluster["representative"]) \
            else "ok - fallback, unverified pattern"
        min_conf = 0.25 if reconstructed_note == "ok - pattern match" else 0.4
        if best_conf < min_conf:
            return None

        self.confirmed.add(cluster["representative"])
        return {
            "plate_number": cluster["representative"],
            "confidence": float(round(best_conf, 2)),
            "note": reconstructed_note,
        }


def preprocess_for_ocr(img):
    """
    Upscales small crops and boosts local contrast (CLAHE) before OCR.
    Helps with distant/motion-blurred plates where raw OCR confidence
    is too low to pass filtering, even though the text is genuinely there.
    """
    h, w = img.shape[:2]
    if max(h, w) < 300:
        scale = 300 / max(h, w)
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    return enhanced

def detect_plate_from_frame(infer_frame, raw_frame):
    """
    Runs YOLO on the small infer_frame (fast), but crops the plate region
    from the full-resolution raw_frame for OCR (maximum detail).
    """
    if infer_frame is None or raw_frame is None:
        return {"error": "Empty frame"}

    results = yolo_model(infer_frame, verbose=False)
    vehicle_classes = {2, 3, 5, 7}

    best_crop = None
    best_area = 0

    infer_h, infer_w = infer_frame.shape[:2]
    raw_h, raw_w = raw_frame.shape[:2]
    scale_x = raw_w / infer_w
    scale_y = raw_h / infer_h

    for r in results:
        for box in r.boxes:
            cls_id = int(box.cls[0])
            if cls_id in vehicle_classes:
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                area = (x2 - x1) * (y2 - y1)
                if area > best_area:
                    best_crop = (
                        int(x1 * scale_x), int(y1 * scale_y),
                        int(x2 * scale_x), int(y2 * scale_y)
                    )
                    best_area = area

    if best_crop is None:
        return {"plate_number": None, "confidence": 0, "note": "No vehicle detected"}

    x1, y1, x2, y2 = best_crop
    vehicle_img = raw_frame[y1:y2, x1:x2]

    processed = preprocess_for_ocr(vehicle_img)
    ocr_results = ocr_reader.readtext(processed)

    if not ocr_results:
        return {"plate_number": None, "confidence": 0, "note": "Vehicle found, no text read"}

    candidates = []
    fallback_candidates = []

    for (_, text, conf) in ocr_results:
        if '.' in text:
            continue
        cleaned = re.sub(r'[^A-Z0-9]', '', text.upper())
        if INDIAN_PLATE_PATTERN.match(cleaned):
            candidates.append((cleaned, conf))
        elif 6 <= len(cleaned) <= 12 and cleaned[:2].isalpha() \
                and any(c.isdigit() for c in cleaned) and any(c.isalpha() for c in cleaned):
            # Real Indian plates always start with a 2-letter state code —
            # "starts with a digit" text (dashcam brand/sticker text like
            # "1008ELECTRIC") was confirming as a false-positive plate.
            fallback_candidates.append((cleaned, conf))

    if candidates:
        candidates.sort(key=lambda x: x[1], reverse=True)
        plate_text, ocr_conf = candidates[0]
        note = "ok - pattern match"
    elif fallback_candidates:
        fallback_candidates.sort(key=lambda x: x[1], reverse=True)
        plate_text, ocr_conf = fallback_candidates[0]
        note = "ok - fallback, unverified pattern"
    else:
        return {"plate_number": None, "confidence": 0, "note": "Text found, none plate-shaped"}

    return {
        "plate_number": plate_text,
        "confidence": round(ocr_conf, 2),
        "note": note
    }


def detect_plate(image_path):
    """Wrapper for testing against static image files (unaffected by the
    live-stream reader — uses the raw image directly for both stages)."""
    img = cv2.imread(image_path)
    if img is None:
        return {"error": f"Could not read image at {image_path}"}
    return detect_plate_from_frame(img, img)


def send_detection_to_watchlist(plate_number, camera_id_str):
    camera_id_int = CAMERA_ID_MAP.get(camera_id_str)
    if camera_id_int is None:
        print(f"[WARN] No numeric camera_id mapped for '{camera_id_str}', skipping API call")
        return

    headers = {"X-Internal-Key": INTERNAL_KEY}
    body = {
        "camera_id": camera_id_int,
        "plate_number": plate_number
    }
    try:
        response = requests.post(ALERT_API_URL, json=body, headers=headers, timeout=3)
        if response.status_code == 201:
            print(f"[ALERT] Watchlist match: {response.json()}")
        elif response.status_code == 204:
            pass
        else:
            print(f"[WARN] Unexpected response {response.status_code}: {response.text}")
    except requests.exceptions.RequestException as e:
        print(f"[WARN] Could not reach watchlist API: {e}")


def process_stream(rtsp_url, camera_id, process_every_n_frames=30, confirm_threshold=2, window_size=10):
    stream = RTSPStreamReader(rtsp_url=rtsp_url, inference_dim=(640, 360)).start()

    print(f"Connected to stream: {rtsp_url}")
    print("Press Ctrl+C to stop.\n")

    frame_count = 0
    tracker = PlateConfirmationTracker(window_size=window_size, confirm_threshold=confirm_threshold)

    try:
        while True:
            ready, raw_frame, infer_frame = stream.read_latest()
            if not ready:
                continue

            frame_count += 1
            if frame_count % process_every_n_frames != 0:
                continue

            result = detect_plate_from_frame(infer_frame, raw_frame)
            plate = result.get("plate_number")

            if not plate:
                continue

            confirmed = tracker.add(plate, result["confidence"], result["note"])
            if confirmed:
                event = {
                    "event_id": str(uuid.uuid4()),
                    "camera_id": camera_id,
                    "plate_number": confirmed["plate_number"],
                    "confidence": confirmed["confidence"],
                    "timestamp": datetime.now(timezone.utc).isoformat()
                }
                print(f"[CONFIRMED EVENT] {event} | {confirmed['note']}")
                if confirmed["note"] == "ok - pattern match":
                    send_detection_to_watchlist(confirmed["plate_number"], camera_id)
                else:
                    print(f"[SKIPPED WATCHLIST] fallback/unverified plate, not sent: {confirmed['plate_number']}")

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
    tracker = PlateConfirmationTracker(window_size=window_size, confirm_threshold=confirm_threshold)

    while True:
        ret, frame = cap.read()
        if not ret:
            print("End of video file")
            break

        frame_count += 1
        if frame_count % process_every_n_frames != 0:
            continue

        result = detect_plate_from_frame(frame, frame)
        plate = result.get("plate_number")

        if not plate:
            continue
        print(f"[reading, frame {frame_count}] {result}")

        confirmed = tracker.add(plate, result["confidence"], result["note"])
        if confirmed:
            event = {
                "event_id": str(uuid.uuid4()),
                "camera_id": camera_id,
                "plate_number": confirmed["plate_number"],
                "confidence": confirmed["confidence"],
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            print(f"[CONFIRMED EVENT] {event} | {confirmed['note']}")
    cap.release()
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
    tracker = PlateConfirmationTracker(window_size=window_size, confirm_threshold=confirm_threshold)

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

            result = detect_plate_from_frame(frame, frame)
            plate = result.get("plate_number")

            if not plate:
                continue

            confirmed = tracker.add(plate, result["confidence"], result["note"])
            if confirmed:
                event = {
                    "event_id": str(uuid.uuid4()),
                    "camera_id": camera_id,
                    "plate_number": confirmed["plate_number"],
                    "confidence": confirmed["confidence"],
                    "timestamp": datetime.now(timezone.utc).isoformat()
                }
                print(f"[CONFIRMED EVENT] {event} | {confirmed['note']}")
                if confirmed["note"] == "ok - pattern match":
                    send_detection_to_watchlist(confirmed["plate_number"], camera_id)

    except KeyboardInterrupt:
        print("\n\nStream stopped by user.")
        print(f"Total confirmed plates this session: {tracker.confirmed}")

    finally:
        cap.release()

if __name__ == "__main__":
    RUN_STATIC_TESTS = False

    if RUN_STATIC_TESTS:
        for fname in os.listdir("test_images"):
            path = os.path.join("test_images", fname)
            result = detect_plate(path)
            print(fname, "->", result)

    # Live tunnel (P3's Cloudflare quick tunnel) is unreliable due to poor
    # connectivity at the hackathon venue — testing against a locally stored
    # dashcam video instead (gitignored, disposable local test material).
    process_video_file("dashcam_trimmed.mp4", camera_id="camera16", process_every_n_frames=10)