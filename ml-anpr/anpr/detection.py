"""Per-vehicle plate reading (crop -> enhance -> OCR -> candidate
filtering) and the per-frame YOLO detection pass that feeds it."""
import os
import re

import cv2
import requests

from .config import yolo_model, device
from .enhancement import is_low_light, enhance_low_light, is_blurry, enhance_motion_blur
from .plate_format import INDIAN_PLATE_PATTERN, _correct_plate_positions, _correct_state_code


# Real, evidence-driven addition (269-frame Anand CCTV eval, Session 32/33):
# 81% of vehicle boxes produced no usable plate read, and inspecting the
# actual failing crops showed why -- plate_region_crop() below is a
# percentage-of-vehicle-box *guess*, not a real plate detector. A real
# plate can be a genuinely tiny, off-band region (a distant van's plate
# measured ~20x8px inside a 140px-wide crop, invisible to a fixed-band
# heuristic no matter how the percentages are tuned), and a percentage
# band has no way to *not* fire on non-plate text in that band (a truck's
# tailgate brand text, a windshield sticker) the way a trained detector
# can simply decline to produce a box at all.
#
# Pretrained YOLOv8n, single class "license_plate", MIT licensed --
# https://huggingface.co/Koushim/yolov8-license-plate-detection -- not
# trained by this project, but real, currently published, and directly
# loadable via the same ultralytics.YOLO(...) call already used for
# yolo_model above. Fetched once and cached, same pattern
# enhancement._get_nafnet_model() already established for NAFNet's
# checkpoint (not committed to git, lazy-loaded on first use so a stream
# that never needs it never pays the download).
_LP_MODEL_CACHE_DIR = os.path.expanduser("~/.cache/netra_lp_detect")
_LP_MODEL_PATH = os.path.join(_LP_MODEL_CACHE_DIR, "yolov8_license_plate.pt")
_LP_MODEL_URL = "https://huggingface.co/Koushim/yolov8-license-plate-detection/resolve/main/best.pt"

_lp_model = None
_lp_model_unavailable = False


def _get_lp_model():
    """Lazily loads and caches the plate-detector model, same fetch-once-
    on-first-use pattern as enhancement._get_nafnet_model(). Returns None
    (not an exception) if the checkpoint can't be fetched or loaded --
    callers treat that exactly like "no box found", not an error, so a
    stream on a machine with no cached weights and no network at that
    moment degrades to the existing plate_region_crop() heuristic instead
    of crashing."""
    global _lp_model, _lp_model_unavailable
    if _lp_model is not None:
        return _lp_model
    if _lp_model_unavailable:
        return None

    from ultralytics import YOLO

    try:
        if not os.path.exists(_LP_MODEL_PATH):
            os.makedirs(_LP_MODEL_CACHE_DIR, exist_ok=True)
            print(f"[lp_detect] downloading plate-detector weights to {_LP_MODEL_PATH} ...")
            response = requests.get(_LP_MODEL_URL, timeout=60)
            response.raise_for_status()
            with open(_LP_MODEL_PATH, "wb") as f:
                f.write(response.content)
    except requests.exceptions.RequestException as e:
        print(f"[WARN] Plate-detector weights unavailable ({e}), falling back to plate_region_crop() heuristic")
        if os.path.exists(_LP_MODEL_PATH):
            os.remove(_LP_MODEL_PATH)  # don't leave a partial/corrupt file cached
        _lp_model_unavailable = True
        return None

    model = YOLO(_LP_MODEL_PATH)
    model.to(device)
    _lp_model = model
    return model


# Ultralytics' own default detection confidence -- not yet tuned against
# our own footage beyond the aggregate eval below; a real lever to revisit
# if precision/recall needs adjusting once more data is available.
LP_DETECT_CONFIDENCE = 0.25

# Margin added around a detected box before crop -- a trained detector's
# box can sit right at character edges (unlike plate_region_crop()'s
# already-generous percentage band), so a small pad guards against
# clipping the first/last character.
LP_DETECT_BOX_MARGIN_FRACTION = 0.08

# OCR reads small text poorly regardless of how it got small -- scaling
# every detected plate crop to a fixed target width (rather than a flat
# multiplier like plate_region_crop()'s 2x) means a tiny distant plate
# gets scaled up much more than a close, already-large one, instead of
# both getting the same multiplier. 240px chosen as comfortably above
# PaddleOCR's effective minimum text height on this project's own
# ground-truth images (see ALPR_IMPROVEMENT_LOG.md OCR engine comparison).
LP_DETECT_TARGET_WIDTH = 240


def detect_plate_box_crop(vehicle_img):
    """
    Runs the dedicated plate-detector model on a vehicle crop and returns
    a tightly-cropped, margin-padded, target-width-scaled plate region --
    or None if the model is unavailable or found nothing above
    LP_DETECT_CONFIDENCE. Purely additive: callers should keep running
    plate_region_crop() alongside this, same "never lose what the other
    pass would still have found" philosophy already used for the
    whole-crop vs. band-crop OCR passes below.
    """
    model = _get_lp_model()
    if model is None:
        return None

    h, w = vehicle_img.shape[:2]
    results = model(vehicle_img, conf=LP_DETECT_CONFIDENCE, verbose=False)
    best_box, best_conf = None, 0.0
    for r in results:
        for box in r.boxes:
            conf = float(box.conf[0])
            if conf > best_conf:
                best_box, best_conf = box.xyxy[0], conf
    if best_box is None:
        return None

    x1, y1, x2, y2 = map(int, best_box)
    mx = int((x2 - x1) * LP_DETECT_BOX_MARGIN_FRACTION)
    my = int((y2 - y1) * LP_DETECT_BOX_MARGIN_FRACTION)
    x1, y1 = max(0, x1 - mx), max(0, y1 - my)
    x2, y2 = min(w, x2 + mx), min(h, y2 + my)
    if x2 - x1 < 5 or y2 - y1 < 5:
        return None

    region = vehicle_img[y1:y2, x1:x2]
    scale = LP_DETECT_TARGET_WIDTH / region.shape[1]
    interp = cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA
    return cv2.resize(region, None, fx=scale, fy=scale, interpolation=interp)


def plate_region_crop(vehicle_img):
    """
    Real plates sit in a fairly predictable band of a vehicle's bounding
    box: lower-middle, not the very bottom (bumper/road) or top
    (windshield/hood/grille badge). For a distant or angled vehicle, the
    plate is a tiny fraction of the full vehicle crop, so OCR ends up
    searching mostly irrelevant pixels (badges, mirrors, grille) at low
    effective resolution. Narrowing to this band before OCR raises the
    fraction of real plate pixels in what gets upscaled and read.

    Bottom edge widened 92% -> 98% (feature/plate-region-detector):
    confirmed on two independent real datasets (Dhruv's Tailscale
    training cameras and Sentinel Gujarat/Kaggle footage) that on
    elevated/angled CCTV views -- as opposed to the close, level,
    forward-facing dashcam framing this band was originally tuned
    against -- the plate can sit lower in the vehicle box than 92%,
    right where the old cutoff clipped it. Left the other three edges
    alone: neither diagnosed case implicated the top or sides, and this
    project's own discipline is to fix what's actually been measured
    broken, not everything that theoretically could be.

    Top edge widened 55% -> 35% (real Anand CCTV footage evaluation,
    officially provided, 269 real frames): auto-rickshaws' plates sit
    much higher in the vehicle box than a car's -- measured directly on
    a real rickshaw crop where the plate ("GJ23...25916") occupies
    roughly 40-60% of the box height, entirely above the old 55% start.
    A car's body proportions put its plate near the bumper (still
    covered by the unchanged 98% bottom edge); a rickshaw's compact,
    boxy shape puts it just below the windshield instead. 35% gives
    margin above the measured 40% without needing a vehicle-type
    classifier -- one wider band that covers both shapes, at the cost
    of slightly more non-plate clutter in what OCR has to search.

    Safe against the dashcam-overlay false positive this project has
    already fixed once (Session 3: a close/large vehicle box pulling in
    the dashcam's own burned-in timestamp, misread as a sequence of
    valid-shaped plates): that protection is a *frame*-relative clip
    applied to the vehicle box itself, upstream of this function, in
    detection._read_plate_from_box (`y2 = min(y2, int(raw_h * 0.92))`)
    -- it operates in frame coordinates, not vehicle-crop coordinates,
    so widening this band (a fraction of the already-overlay-excluded
    vehicle_img's own height) doesn't reach back into the overlay band
    except for a vehicle box that itself already sits right at that
    frame-relative boundary -- and re-verified directly against the
    real dashcam_trimmed.mp4 regression after this change, not just
    reasoned about (see ALPR_IMPROVEMENT_LOG.md).
    """
    h, w = vehicle_img.shape[:2]
    y1, y2 = int(0.35 * h), int(0.98 * h)
    x1, x2 = int(0.12 * w), int(0.90 * w)
    if y2 - y1 < 10 or x2 - x1 < 20:
        return None
    region = vehicle_img[y1:y2, x1:x2]

    # 2x upscale before OCR -- measured directly, not assumed: on a real
    # rickshaw plate crop this project's evaluation found, OCR at native
    # resolution read one stray garbage character; at 2x it read the
    # plate's two segments correctly ("GJZJ" ~ GJ23, confidence 0.76;
    # "75916", confidence 0.92). No upscaling existed anywhere in this
    # pipeline before this -- despite this function's own docstring
    # already implying "what gets upscaled," nothing actually did.
    return cv2.resize(region, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)


MIN_VEHICLE_BOX_AREA_FRACTION = 0.03
LOW_CONFIDENCE_BOX_THRESHOLD = 0.4
LOW_CONFIDENCE_BOX_EXPAND_FRACTION = 0.4

# Session (dashcam pipeline-stage audit): the area floor above doesn't
# catch the single most common dashcam false positive -- the recording
# car's OWN bonnet/dashboard, which YOLO frequently misclassifies as a
# vehicle. It's large enough to clear MIN_VEHICLE_BOX_AREA_FRACTION easily,
# but has a giveaway shape no real vehicle box has: measured directly
# across a real dashcam clip, these boxes spanned 98-99% of the frame
# width at only 18-22% of its height (aspect ratio 8.4-14.8), because
# they're a near-full-width strip pinned to the bottom edge. The opposite
# extreme showed up too -- a vehicle clipped by the left/right frame edge
# (e.g. a bus mostly out-of-frame, only its door/mirror visible) measured
# 0.25-0.26, a tall sliver with essentially no chance of containing a
# readable plate. Real vehicle boxes (car/bike/bus/truck, any angle) sit
# comfortably inside both bounds; only these two failure shapes don't.
MIN_VEHICLE_BOX_ASPECT_RATIO = 0.35
MAX_VEHICLE_BOX_ASPECT_RATIO = 5.0


def _read_plate_from_box(box, raw_frame, raw_h, frame_is_dark):
    """
    The per-vehicle detection pipeline (overlay-band clip, crop,
    low-light enhancement, two-pass OCR, candidate filtering) --
    unchanged logic from the pre-Session-7 single-box version, just
    extracted so detect_plate_from_frame can run it once per qualifying
    vehicle box instead of once for the single largest.
    """
    x1, y1, x2, y2 = box

    # Dashcam footage commonly has a fixed UI overlay burned into the
    # bottom strip of every frame (date/time, speed/GPS) -- confirmed
    # directly on dashcam_trimmed.mp4: a close/large "vehicle" box (a
    # mirror or the dashcam's own vehicle) can extend to the frame's
    # bottom edge and pull that overlay text into the OCR crop. The
    # on-screen timestamp increments every frame and was misread as a
    # sequence of structurally-valid-shaped plates (e.g. II22IS3507,
    # II22IS3508, ...), triggering real false-positive watchlist alerts.
    # Real plates aren't mounted in the dashcam's own UI overlay band,
    # so clip the crop's bottom edge to exclude it.
    y2 = min(y2, int(raw_h * 0.92))

    # Real Sentinel Gujarat CCTV footage (cam06/cam07) burns its own
    # overlay into the *top* of frame instead (date/time + location
    # label, e.g. "17-06-2026 18:00:27  Madhuram Bypass Road Fix-2..."),
    # a position the bottom-band clip above doesn't cover at all --
    # confirmed as a real false-positive source: cam06 misread its own
    # "Fix-2" label as plate-shaped text (ADFIX2/DFIX2H/AFIX2EF/DFX2FR,
    # all fallback-tier) and cam07 misread its date overlay's "Sat"
    # weekday as SAT212518/SAT212519. Measured the actual overlay extent
    # directly on saved cam06/cam07 frames rather than guessing: the text
    # sits within the top ~5% of a 1080px frame on both cameras (same
    # overlay style/position), so 8% gives real margin without eating
    # meaningfully into genuine vehicle crops. Same reasoning as the
    # bottom clip -- real plates aren't mounted in a camera's own UI
    # overlay band.
    y1 = max(y1, int(raw_h * 0.08))

    if y2 <= y1:
        return {"plate_number": None, "confidence": 0, "note": "Vehicle box entirely in overlay band", "box": box}

    vehicle_img = raw_frame[y1:y2, x1:x2]
    if frame_is_dark:
        vehicle_img = enhance_low_light(vehicle_img)

    # Session 9/10: motion blur is per-vehicle, not frame-wide, so this
    # is checked on the crop itself, not once per frame like
    # is_low_light(). See is_blurry()'s docstring for the threshold and
    # its known fog-proximity limitation.
    if is_blurry(vehicle_img):
        vehicle_img = enhance_motion_blur(vehicle_img)

    # Deferred, dynamic import (not `from .ocr import _ocr_readtext` at
    # module level): vehicle_trace_demo.py monkeypatches
    # detect_plate._ocr_readtext at runtime to capture raw OCR output for
    # its own reporting. A static import would bind this module's own
    # name to the original function at import time and never see that
    # reassignment; looking it up through the detect_plate shim on every
    # call is what makes the monkeypatch actually take effect.
    import detect_plate
    ocr_results = detect_plate._ocr_readtext(vehicle_img)

    # Second pass on the plate's likely band within the vehicle box — a
    # much higher plate-pixel-density crop than the whole vehicle, so it
    # catches plates the whole-crop pass is too low-signal to read. Kept
    # additive (not a replacement) so a mislocalized crop can't cost us
    # a detection the whole-crop pass would still have found.
    region = plate_region_crop(vehicle_img)
    if region is not None and region.size > 0:
        ocr_results += detect_plate._ocr_readtext(region)

    # Third pass: the real plate-detector model's own tight, target-width
    # crop (see detect_plate_box_crop() above) -- additive alongside the
    # percentage-band pass for the same reason that pass is additive
    # alongside the whole-crop pass, not a replacement for it.
    lp_region = detect_plate_box_crop(vehicle_img)
    if lp_region is not None and lp_region.size > 0:
        ocr_results += detect_plate._ocr_readtext(lp_region)

    if not ocr_results:
        return {"plate_number": None, "confidence": 0, "note": "Vehicle found, no text read", "box": box}

    candidates = []
    fallback_candidates = []

    for (_, text, conf) in ocr_results:
        cleaned = re.sub(r'[^A-Z0-9]', '', text.upper())
        if INDIAN_PLATE_PATTERN.match(cleaned):
            # Real plates are often printed/read with dot separators
            # ("MH.48.AW.4023") — only reject '.' text for the looser
            # fallback tier (see below), since GPS-overlay text
            # ("E77.1247,N28.5475") structurally can't survive cleaning
            # into a full strict-pattern match the way a real plate can.
            #
            # Structurally valid isn't the same as a real state code --
            # see _correct_state_code()'s docstring (Session 33: the
            # plate-detector crop path produced a confidently-wrong
            # "GI23CG2045" for a real "GJ23CG2045", 3 times in the same
            # eval). Demote to fallback instead of trusting an
            # unrecognized code at pattern-match confidence.
            fixed = _correct_state_code(cleaned)
            if fixed is not None:
                candidates.append((fixed, conf))
            else:
                fallback_candidates.append((cleaned, conf))
        elif (corrected := _correct_plate_positions(cleaned)) is not None:
            fixed = _correct_state_code(corrected)
            if fixed is not None:
                candidates.append((fixed, conf))
            else:
                fallback_candidates.append((corrected, conf))
        elif '.' not in text and 6 <= len(cleaned) <= 12 and cleaned[:2].isalpha() \
                and any(c.isdigit() for c in cleaned) and any(c.isalpha() for c in cleaned):
            # Real Indian plates always start with a 2-letter state code —
            # "starts with a digit" text (dashcam brand/sticker text like
            # "1008ELECTRIC") was confirming as a false-positive plate.
            fallback_candidates.append((cleaned, conf))

    # A real plate can come back from OCR as two separate fragments
    # instead of one string -- confirmed directly on a real auto-rickshaw
    # plate ("GJ23...75916"), which PaddleOCR split into "GJZJ" and
    # "75916". Also run each concatenation through the same
    # _correct_plate_positions() confusable-character fix used for single
    # strings below (Z/2, O/0, etc.) -- a split fragment is exactly as
    # likely to have a wrong-type character at a fixed position as a
    # whole-string read is. _ocr_readtext doesn't preserve bounding-box
    # position (always returns bbox=None, see anpr/ocr.py), so there's no
    # real spatial signal to confirm two fragments are actually adjacent
    # on the plate -- only trying ADJACENT entries in the returned list
    # (not every pair) keeps this bounded, and trying both concatenation
    # orders covers OCR not guaranteeing a consistent top-to-bottom
    # sequence. Held to the same strict INDIAN_PLATE_PATTERN bar as any
    # other candidate, never added to the weaker fallback tier -- two
    # unrelated fragments are very unlikely to accidentally concatenate
    # into something that matches that specific structure by chance, but
    # this is a real, if bounded, false-positive risk worth stating
    # plainly rather than glossing over.
    for i in range(len(ocr_results) - 1):
        clean_a = re.sub(r'[^A-Z0-9]', '', ocr_results[i][1].upper())
        clean_b = re.sub(r'[^A-Z0-9]', '', ocr_results[i + 1][1].upper())
        conf_a, conf_b = ocr_results[i][2], ocr_results[i + 1][2]
        for combined in (clean_a + clean_b, clean_b + clean_a):
            if INDIAN_PLATE_PATTERN.match(combined):
                fixed = _correct_state_code(combined)
                if fixed is not None:
                    candidates.append((fixed, min(conf_a, conf_b)))
            elif (corrected := _correct_plate_positions(combined)) is not None:
                fixed = _correct_state_code(corrected)
                if fixed is not None:
                    candidates.append((fixed, min(conf_a, conf_b)))

    if candidates:
        candidates.sort(key=lambda x: x[1], reverse=True)
        plate_text, ocr_conf = candidates[0]
        note = "ok - pattern match"
    elif fallback_candidates:
        fallback_candidates.sort(key=lambda x: x[1], reverse=True)
        plate_text, ocr_conf = fallback_candidates[0]
        note = "ok - fallback, unverified pattern"
    else:
        return {"plate_number": None, "confidence": 0, "note": "Text found, none plate-shaped", "box": box}

    return {
        "plate_number": plate_text,
        "confidence": round(ocr_conf, 2),
        "note": note,
        "box": box,
    }


def detect_plate_from_frame(infer_frame, raw_frame):
    """
    Runs YOLO on the small infer_frame (fast), but crops the plate
    region(s) from the full-resolution raw_frame for OCR (maximum
    detail). Returns a LIST of per-vehicle result dicts (Session 7) --
    every vehicle box clearing both YOLO's own confidence threshold and
    MIN_VEHICLE_BOX_AREA_FRACTION (previously: only the single largest
    box was ever examined, silently discarding every other vehicle in
    frame). See ALPR_IMPROVEMENT_LOG.md Session 7 for why the area
    floor exists -- measured 6-15 vehicle boxes per dashcam frame, most
    of them too small to plausibly contain a legible plate; processing
    all of them unconditionally would be a 6-15x compute multiplier.

    Each result dict includes a "box" key ((x1,y1,x2,y2) in raw_frame
    coordinates) so stateful callers (see tracking.VehicleTracker) can
    associate detections into per-vehicle tracks across frames -- this
    function itself stays stateless and per-frame.

    Returns an empty list if no qualifying vehicle box was found at all.
    """
    if infer_frame is None or raw_frame is None:
        return [{"error": "Empty frame"}]

    # Session 5 measured enhance_low_light() applied unconditionally
    # costing 2.5-3.6x end-to-end video throughput for a partial
    # accuracy gain -- too costly to force in for every frame. Session
    # 6 gates it behind a cheap brightness check instead, so it only
    # runs on frames that are actually dark. See is_low_light()'s
    # docstring for the threshold, and ALPR_IMPROVEMENT_LOG.md Session
    # 6 for the measured cost of this gated version specifically.
    frame_is_dark = is_low_light(infer_frame)
    if frame_is_dark:
        # Session 5/6 validated enhance_low_light() as a net win against
        # *synthetically* darkened test images -- real night CCTV
        # footage (cam07) doesn't generalize the same way, measured
        # directly, not assumed: across 4 real dark frames, the enhanced
        # version lost a vehicle YOLO found on the raw frame entirely in
        # 2/4, reduced confidence in 1/4, and only improved detection in
        # 1/4. Running YOLO on both and merging their boxes can only
        # recover what enhancement would otherwise silently destroy --
        # never loses a raw-frame detection, at the cost of a second
        # YOLO pass on dark frames only (accepted; this project's video
        # sources are frequently night footage where losing detections
        # matters more than the extra latency).
        results = list(yolo_model(infer_frame, verbose=False)) + \
            list(yolo_model(enhance_low_light(infer_frame), verbose=False))
    else:
        results = yolo_model(infer_frame, verbose=False)
    vehicle_classes = {2, 3, 5, 7}

    infer_h, infer_w = infer_frame.shape[:2]
    raw_h, raw_w = raw_frame.shape[:2]
    scale_x = raw_w / infer_w
    scale_y = raw_h / infer_h
    min_area = MIN_VEHICLE_BOX_AREA_FRACTION * raw_h * raw_w

    boxes = []
    for r in results:
        for box in r.boxes:
            cls_id = int(box.cls[0])
            if cls_id in vehicle_classes:
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                raw_box = (
                    int(x1 * scale_x), int(y1 * scale_y),
                    int(x2 * scale_x), int(y2 * scale_y)
                )
                # Session 11: low-confidence YOLO boxes measurably
                # under-estimate the vehicle's true extent, cutting off
                # the bumper/plate area -- confirmed directly on the
                # low-light degraded set (box conf 0.26-0.29 vs. 0.54-0.88
                # for well-detected clean-image boxes; 0.4 sits with
                # real margin on both sides). Expanding the bottom edge
                # by 40% of box height for low-confidence boxes recovered
                # a plate that was otherwise completely missed
                # (car1_lowlight.jpg: no OCR text at all -> exact match,
                # 0.97 conf). Only the bottom edge, since that's
                # specifically where the plate/bumper sits and where
                # under-detection was observed -- not widening the box
                # in every direction, which risks pulling in adjacent
                # vehicles or the dashcam overlay band unnecessarily.
                box_conf = float(box.conf[0])
                if box_conf < LOW_CONFIDENCE_BOX_THRESHOLD:
                    box_h = raw_box[3] - raw_box[1]
                    raw_box = (
                        raw_box[0], raw_box[1], raw_box[2],
                        min(raw_h, int(raw_box[3] + LOW_CONFIDENCE_BOX_EXPAND_FRACTION * box_h)),
                    )
                box_w = raw_box[2] - raw_box[0]
                box_h = raw_box[3] - raw_box[1]
                area = box_w * box_h
                aspect_ratio = box_w / max(1, box_h)
                if area >= min_area and MIN_VEHICLE_BOX_ASPECT_RATIO <= aspect_ratio <= MAX_VEHICLE_BOX_ASPECT_RATIO:
                    boxes.append(raw_box)

    if not boxes:
        return [{"plate_number": None, "confidence": 0, "note": "No vehicle detected", "box": None}]

    return [_read_plate_from_box(box, raw_frame, raw_h, frame_is_dark) for box in boxes]


def detect_plate(image_path):
    """
    Wrapper for testing against static image files (unaffected by the
    live-stream reader — uses the raw image directly for both stages).

    detect_plate_from_frame() returns a list (Session 7, multi-vehicle
    support) -- kept this wrapper's return contract as a single dict,
    unchanged, since every existing ground-truth test image has exactly
    one vehicle and every regression check in this log's history calls
    detect_plate(...).get(...) expecting one dict. Picks the
    largest-box result, matching the pre-Session-7 single-box behavior
    exactly for the single-vehicle case this wrapper is actually used
    for.
    """
    img = cv2.imread(image_path)
    if img is None:
        return {"error": f"Could not read image at {image_path}"}
    results = detect_plate_from_frame(img, img)
    if not results or "error" in results[0]:
        return results[0] if results else {"error": "No result"}
    return max(results, key=lambda r: (r["box"][2] - r["box"][0]) * (r["box"][3] - r["box"][1]) if r["box"] else 0)
