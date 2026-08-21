import cv2
from ultralytics import YOLO
import easyocr
import re
import os

# Load a pretrained YOLO model (detects general objects, including "car")
# On first run this auto-downloads the model weights (~6MB), needs internet.
yolo_model = YOLO("yolov8n.pt")

# Load EasyOCR reader — 'en' works fine for alphanumeric plates
# On first run this also downloads model weights, needs internet.
ocr_reader = easyocr.Reader(['en'], gpu=False)

def detect_plate(image_path):
    """
    Takes a path to an image, finds a vehicle, crops the lower portion
    (where the plate usually sits), runs OCR, and returns the result.
    """
    img = cv2.imread(image_path)
    if img is None:
        return {"error": f"Could not read image at {image_path}"}

    # Step 1: run YOLO to detect objects in the image
    results = yolo_model(img, verbose=False)

    # COCO class IDs: 2 = car, 3 = motorcycle, 5 = bus, 7 = truck
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

    # Step 2: run OCR on the WHOLE vehicle crop, not a guessed sub-region
    debug_path = f"debug_{os.path.basename(image_path)}"
    cv2.imwrite(debug_path, vehicle_img)

    ocr_results = ocr_reader.readtext(vehicle_img)

    if not ocr_results:
        return {"plate_number": None, "confidence": 0, "note": "Vehicle found, no text read"}

    # Pick the OCR result with the highest confidence
    # Filter to text that looks like a plate: mostly letters/digits, reasonable length
    candidates = []
    for (_, text, conf) in ocr_results:
        cleaned = re.sub(r'[^A-Z0-9]', '', text.upper())
        if 6 <= len(cleaned) <= 12:
            candidates.append((cleaned, conf))

    if not candidates:
        return {"plate_number": None, "confidence": 0, "note": "Text found, none plate-shaped"}

    candidates.sort(key=lambda x: x[1], reverse=True)
    plate_text, ocr_conf = candidates[0]

    return {
        "plate_number": plate_text,
        "confidence": round(ocr_conf, 2),
        "note": "ok"
    }


if __name__ == "__main__":
    for fname in os.listdir("test_images"):
        path = os.path.join("test_images", fname)
        result = detect_plate(path)
        print(fname, "->", result)