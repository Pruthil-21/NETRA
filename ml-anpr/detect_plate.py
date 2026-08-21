import os
import re
import uuid
from datetime import datetime, timezone

import cv2
import torch
import requests
from ultralytics import YOLO
import easyocr

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
}

os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"

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


def detect_plate_from_frame(img):
    if img is None:
        return {"error": "Empty frame"}

    results = yolo_model(img, verbose=False)
    vehicle_classes = {2, 3, 5, 7}

    best_crop = None
    best_area = 0

    for r in results:
        for box in r.boxes:
            cls_id = int(box.cls[0])
            if cls_id in vehicle_classes:
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                area = (x2 - x1) * (y2 - y1)
                if area > best_area:
                    best_crop = (x1, y1, x2, y2)
                    best_area = area

    if best_crop is None:
        return {"plate_number": None, "confidence": 0, "note": "No vehicle detected"}

    x1, y1, x2, y2 = best_crop
    vehicle_img = img[y1:y2, x1:x2]

    ocr_results = ocr_reader.readtext(vehicle_img)

    if not ocr_results:
        return {"plate_number": None, "confidence": 0, "note": "Vehicle found, no text read"}

    candidates = []
    fallback_candidates = []

    for (_, text, conf) in ocr_results:
        cleaned = re.sub(r'[^A-Z0-9]', '', text.upper())
        if INDIAN_PLATE_PATTERN.match(cleaned):
            candidates.append((cleaned, conf))
        elif 6 <= len(cleaned) <= 12:
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
    img = cv2.imread(image_path)
    if img is None:
        return {"error": f"Could not read image at {image_path}"}
    return detect_plate_from_frame(img)


def send_detection_to_watchlist(plate_number, camera_id_str):
    """Sends a confirmed plate to P6's watchlist-matching API."""
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
    cap = cv2.VideoCapture(rtsp_url)

    if not cap.isOpened():
        print(f"Failed to open stream: {rtsp_url}")
        return

    print(f"Connected to stream: {rtsp_url}")
    print("Press Ctrl+C to stop.\n")

    frame_count = 0
    recent_detections = []
    confirmed_plates = set()

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("Stream ended or connection lost")
                break

            frame_count += 1
            if frame_count % process_every_n_frames != 0:
                continue

            result = detect_plate_from_frame(frame)
            plate = result.get("plate_number")

            if not plate or result["confidence"] < 0.4:
                continue

            recent_detections.append((plate, result["confidence"]))
            recent_detections = recent_detections[-window_size:]

            count = sum(1 for p, _ in recent_detections if p == plate)

            if count >= confirm_threshold and plate not in confirmed_plates:
                best_conf = max(c for p, c in recent_detections if p == plate)
                event = {
                    "event_id": str(uuid.uuid4()),
                    "camera_id": camera_id,
                    "plate_number": plate,
                    "confidence": float(round(best_conf, 2)),
                    "timestamp": datetime.now(timezone.utc).isoformat()
                }
                print(f"[CONFIRMED EVENT] {event}")
                confirmed_plates.add(plate)

                send_detection_to_watchlist(plate, camera_id)

    except KeyboardInterrupt:
        print("\n\nStream stopped by user.")
        print(f"Total confirmed plates this session: {confirmed_plates}")

    finally:
        cap.release()


if __name__ == "__main__":
    for fname in os.listdir("test_images"):
        path = os.path.join("test_images", fname)
        result = detect_plate(path)
        print(fname, "->", result)

    # process_stream("rtsp://192.168.31.233:8554/camera1", camera_id="camera1")
    process_stream("rtsp://192.168.31.233:8554/livecam", camera_id="livecam")