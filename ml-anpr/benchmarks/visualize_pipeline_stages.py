"""Saves one image per pipeline stage, per detected vehicle, from a video --
before/ (raw vehicle crop) -> vehicle_boxes/ (full frame with the vehicle
box drawn) -> plate_boxes/ (crop with the plate-search band outlined) ->
after/ (the fully-processed crop exactly as handed to OCR, post low-light
and/or NAFNet deblur). Matching filenames across the four folders so a
viewer can flip through the same vehicle's stages side by side.

Doesn't modify the real pipeline (anpr/detection.py, anpr/enhancement.py
stay untouched, per team policy) -- reuses its actual functions via
detect_plate.py's re-export surface (`detect_plate.X`) plus a direct import
of `_read_plate_from_box` (not re-exported, since only whole-frame entry
points normally need it) for the authoritative validated result. Only the
small YOLO box-extraction loop is duplicated, unavoidable without editing
anpr/detection.py directly (detect_plate_from_frame does box-extraction,
OCR, and enhancement all in one call, with no seam to hook a visualization
into without re-running the box pass a second time).

Run: python benchmarks/visualize_pipeline_stages.py --video "C:\\path.mp4"
GPU only by design (this run) -- doesn't touch CUDA_VISIBLE_DEVICES, so it
uses whatever anpr/config.py's own device auto-detection picks (cuda here).
"""
import argparse
import os
import sys

import cv2


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--process-every-n-frames", type=int, default=10)
    args = parser.parse_args()

    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
    import detect_plate  # noqa: E402
    # _read_plate_from_box isn't re-exported through detect_plate.py's shim
    # (only whole-frame entry points are) -- imported directly here so the
    # "plate=" this script reports is the REAL validated result (pattern
    # match / fallback / rejected), not a raw best-confidence OCR guess.
    # An earlier version of this script used the raw guess, which made
    # correctly-rejected reads (garbage text off a door panel or tyre) look
    # like false-positive plate detections when they were never actually
    # accepted by the real pipeline.
    from anpr.detection import _read_plate_from_box  # noqa: E402

    test_images_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "test_images"))
    stage_dirs = {
        "before": os.path.join(test_images_dir, "before"),
        "vehicle_boxes": os.path.join(test_images_dir, "vehicle_boxes"),
        "plate_boxes": os.path.join(test_images_dir, "plate_boxes"),
        "after": os.path.join(test_images_dir, "after"),
    }
    for d in stage_dirs.values():
        os.makedirs(d, exist_ok=True)

    vehicle_classes = {2, 3, 5, 7}

    def extract_vehicle_boxes(infer_frame, raw_frame):
        """Duplicates detect_plate_from_frame's box-extraction (not its
        OCR/enhancement calls) purely to get raw vehicle boxes to draw/crop
        for this visualization."""
        frame_is_dark = detect_plate.is_low_light(infer_frame)
        results = detect_plate.yolo_model(
            detect_plate.enhance_low_light(infer_frame) if frame_is_dark else infer_frame, verbose=False
        )
        infer_h, infer_w = infer_frame.shape[:2]
        raw_h, raw_w = raw_frame.shape[:2]
        scale_x = raw_w / infer_w
        scale_y = raw_h / infer_h
        min_area = detect_plate.MIN_VEHICLE_BOX_AREA_FRACTION * raw_h * raw_w

        boxes = []
        for r in results:
            for box in r.boxes:
                if int(box.cls[0]) not in vehicle_classes:
                    continue
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                raw_box = (int(x1 * scale_x), int(y1 * scale_y), int(x2 * scale_x), int(y2 * scale_y))
                box_conf = float(box.conf[0])
                if box_conf < detect_plate.LOW_CONFIDENCE_BOX_THRESHOLD:
                    box_h = raw_box[3] - raw_box[1]
                    raw_box = (
                        raw_box[0], raw_box[1], raw_box[2],
                        min(raw_h, int(raw_box[3] + detect_plate.LOW_CONFIDENCE_BOX_EXPAND_FRACTION * box_h)),
                    )
                box_w = raw_box[2] - raw_box[0]
                box_h = raw_box[3] - raw_box[1]
                area = box_w * box_h
                aspect_ratio = box_w / max(1, box_h)
                if (area >= min_area
                        and detect_plate.MIN_VEHICLE_BOX_ASPECT_RATIO <= aspect_ratio <= detect_plate.MAX_VEHICLE_BOX_ASPECT_RATIO):
                    boxes.append(raw_box)
        return boxes, frame_is_dark

    def process_vehicle(raw_frame, box, frame_is_dark, frame_idx, vehicle_idx):
        x1, y1, x2, y2 = box
        raw_h = raw_frame.shape[0]
        y2 = min(y2, int(raw_h * 0.92))  # same dashcam-overlay clip as _read_plate_from_box
        if y2 <= y1:
            return None

        tag = f"frame{frame_idx:05d}_vehicle{vehicle_idx}"

        # 1. before/ -- raw vehicle crop, untouched
        vehicle_img = raw_frame[y1:y2, x1:x2]
        cv2.imwrite(os.path.join(stage_dirs["before"], f"{tag}.jpg"), vehicle_img)

        # 2. vehicle_boxes/ -- full frame with this vehicle's box drawn
        boxed_frame = raw_frame.copy()
        cv2.rectangle(boxed_frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
        cv2.imwrite(os.path.join(stage_dirs["vehicle_boxes"], f"{tag}.jpg"), boxed_frame)

        # Same enhancement order as the real pipeline (_read_plate_from_box)
        processed = vehicle_img
        if frame_is_dark:
            processed = detect_plate.enhance_low_light(processed)
        was_blurry = detect_plate.is_blurry(processed)
        if was_blurry:
            processed = detect_plate.enhance_motion_blur(processed)

        # 3. plate_boxes/ -- the crop (post low-light enhance if applied) with
        # the plate-search band outlined, matching plate_region_crop's own
        # geometry (0.55-0.92h, 0.12-0.90w) -- drawn here rather than calling
        # that function directly since it returns the cropped pixels, not
        # the coordinates.
        h, w = processed.shape[:2]
        py1, py2 = int(0.55 * h), int(0.92 * h)
        px1, px2 = int(0.12 * w), int(0.90 * w)
        plate_boxed = processed.copy()
        cv2.rectangle(plate_boxed, (px1, py1), (px2, py2), (0, 0, 255), 2)
        cv2.imwrite(os.path.join(stage_dirs["plate_boxes"], f"{tag}.jpg"), plate_boxed)

        # 4. after/ -- fully processed crop, exactly as handed to OCR
        suffix = "deblurred" if was_blurry else "noenhance"
        cv2.imwrite(os.path.join(stage_dirs["after"], f"{tag}_{suffix}.jpg"), processed)

        # Real, validated result -- same function detect_plate_from_frame
        # itself calls per vehicle (pattern match / fallback tier /
        # rejected as "none plate-shaped"), not a raw OCR guess.
        result = _read_plate_from_box((x1, y1, x2, y2), raw_frame, raw_h, frame_is_dark)
        return {
            "tag": tag, "blurry": was_blurry, "dark": frame_is_dark,
            "plate": result.get("plate_number"), "confidence": result.get("confidence"),
            "note": result.get("note"),
        }

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"Failed to open video: {args.video}")
        return

    frame_count = 0
    saved = 0
    rows = []
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frame_count += 1
        if frame_count % args.process_every_n_frames != 0:
            continue

        boxes, frame_is_dark = extract_vehicle_boxes(frame, frame)
        for vi, box in enumerate(boxes):
            result = process_vehicle(frame, box, frame_is_dark, frame_count, vi)
            if result:
                saved += 1
                rows.append(result)
                print(f"[frame {frame_count:>5}] vehicle {vi}: plate={result['plate']} "
                      f"conf={result['confidence']} blurry={result['blurry']} dark={result['dark']} "
                      f"note={result['note']}", flush=True)
    cap.release()

    with_plate = [r for r in rows if r["plate"]]
    blurry_count = sum(1 for r in rows if r["blurry"])
    print(f"\nSaved {saved} vehicle instance(s) x 4 stages into {test_images_dir}\\{{before,vehicle_boxes,plate_boxes,after}}\\")
    print(f"NAFNet deblur triggered on {blurry_count}/{saved} ({100 * blurry_count / saved:.1f}%)" if saved else "")
    print(f"Plate read on {len(with_plate)}/{saved} ({100 * len(with_plate) / saved:.1f}%)" if saved else "")


if __name__ == "__main__":
    main()
