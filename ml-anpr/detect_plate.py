import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone

import cv2
import requests
import torch
from paddleocr import PaddleOCR
from ultralytics import YOLO

# Allow importing streaming/rtsp_reader.py even when running from inside
# ml-anpr/ — adds the repo root to the path so `streaming` is importable.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from streaming.rtsp_reader import RTSPStreamReader

# Same reasoning, for the vendored nafnet/ package (Session 10) --
# makes it importable regardless of the caller's cwd, not just when
# cwd happens to be ml-anpr/.
sys.path.insert(0, os.path.dirname(__file__))

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

# Swapped from EasyOCR after a head-to-head test on our own ground-truth
# images: PaddleOCR (PP-OCRv6) got 3/3 exact matches on raw output with
# zero custom correction logic, at 0.999-1.000 confidence, vs. EasyOCR's
# 0.45-0.93 (needing the correction logic below to reach the same 3/3).
# Full methodology and numbers in ALPR_IMPROVEMENT_LOG.md.
ocr_reader = PaddleOCR(use_angle_cls=True, lang='en')


def _ocr_readtext(img):
    """
    Adapter matching EasyOCR's readtext() return shape
    (list of (bbox, text, confidence)) so the candidate-filtering logic
    below didn't need to change when the OCR engine did. PaddleOCR needs
    a 3-channel image -- unlike EasyOCR it crashes on the grayscale
    output of preprocess_for_ocr(), and testing showed it doesn't need
    that preprocessing anyway (it has its own internal doc/text
    preprocessing): the raw BGR crop alone scored 0.999-1.000 on every
    ground-truth image tested.
    """
    results = ocr_reader.predict(img)
    return [
        (None, text, conf)
        for r in results
        for text, conf in zip(r.get('rec_texts', []), r.get('rec_scores', []))
    ]


INDIAN_PLATE_PATTERN = re.compile(r'^[A-Z]{2}[0-9]{2}[A-Z]{1,2}[0-9]{4}$')

_DIGIT_TO_LETTER = {'0': 'O', '1': 'I', '2': 'Z', '5': 'S', '8': 'B', '6': 'G'}
_LETTER_TO_DIGIT = {v: k for k, v in _DIGIT_TO_LETTER.items()}


def _correct_plate_positions(cleaned):
    """
    Indian plates have fixed character-class positions: letters, then
    digits, then letters, then digits. OCR commonly confuses
    visually-similar letter/digit pairs (O/0, I/1, Z/2, S/5, B/8, G/6) --
    confirmed directly against ground truth on car2.jpg (HR2OAG3739 vs
    real HR20AG3739) and car3.jpg (MHZODV2366 vs real MH20DV2366), both
    single wrong-type characters at digit positions. If a cleaned OCR
    string is exactly plate-length but has a wrong-type character at a
    fixed position, try correcting it via the known confusion map, and
    only accept the correction if the result then matches the strict
    pattern -- so this can't turn arbitrary text into a fake plate, only
    recover a plate that was one confusable character away from matching.
    """
    for total_len, letter_run in ((10, 2), (9, 1)):
        if len(cleaned) != total_len:
            continue
        expected = ['L', 'L', 'D', 'D'] + ['L'] * letter_run + ['D'] * 4
        chars = list(cleaned)
        changed = False
        for i, kind in enumerate(expected):
            c = chars[i]
            if kind == 'D' and c in _LETTER_TO_DIGIT:
                chars[i] = _LETTER_TO_DIGIT[c]
                changed = True
            elif kind == 'L' and c in _DIGIT_TO_LETTER:
                chars[i] = _DIGIT_TO_LETTER[c]
                changed = True
        if changed:
            candidate = ''.join(chars)
            if INDIAN_PLATE_PATTERN.match(candidate):
                return candidate
    return None


def _edit_similarity(a, b):
    """Normalized edit-distance similarity (1.0 = identical). Tolerant of
    both character substitution (motion blur misreading one character as
    another) AND length differences (OCR dropping/inserting a character
    on a harder read of the same real plate) — same-length-only matching
    missed real repeat plates that read as slightly different lengths."""
    if a == b:
        return 1.0
    la, lb = len(a), len(b)
    dp = list(range(lb + 1))
    for i in range(1, la + 1):
        prev, dp[0] = dp[0], i
        for j in range(1, lb + 1):
            prev, dp[j] = dp[j], min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] != b[j - 1]))
    return 1 - dp[lb] / max(la, lb)


def _containment_similarity(short, long_):
    """Best contiguous-window character match of `short` inside `long_`,
    normalized by the short string's own length. Catches truncated reads
    (a plate partially cut off at the edge of a crop, or OCR just not
    extending across the full width) — a 7-character prefix of an
    11-character plate is a perfect read as far as it goes, but plain
    edit-distance similarity is capped by the length gap alone and can
    never clear a reasonable clustering threshold."""
    ls, ll = len(short), len(long_)
    if ls == 0 or ls > ll:
        return 0.0
    return max(
        sum(1 for x, y in zip(short, long_[start:start + ls]) if x == y) / ls
        for start in range(ll - ls + 1)
    )


def _plate_similarity(a, b):
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    return max(_edit_similarity(a, b), _containment_similarity(shorter, longer))


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
        """Per-character voting requires aligned positions, which only
        makes sense within one length. A cluster can hold readings of
        several lengths (edit-distance clustering tolerates dropped/
        inserted characters), so vote on the dominant length first, then
        vote characters only among readings of that length — the other
        lengths still count toward cluster membership, just not toward
        the reconstructed string."""
        length_weights = {}
        for plate, conf, note in readings:
            weight = conf * (cls.PATTERN_MATCH_VOTE_WEIGHT if note == "ok - pattern match" else 1.0)
            length_weights[len(plate)] = length_weights.get(len(plate), 0.0) + weight
        dominant_length = max(length_weights, key=length_weights.get)

        chars = []
        for i in range(dominant_length):
            votes = {}
            for plate, conf, note in readings:
                if len(plate) != dominant_length:
                    continue
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

        if len(cluster["readings"]) < self.confirm_threshold:
            return None

        # A single real, hard-to-read plate can still split across two
        # incompatible-length clusters that never merge (e.g. flip-flopping
        # on whether an ambiguous character is even present) — each can
        # independently cross confirm_threshold. Rather than solve general
        # cluster merging, just refuse to fire a second alert for something
        # already close to an already-confirmed plate.
        if any(_plate_similarity(cluster["representative"], c) >= self.SIMILARITY_THRESHOLD for c in self.confirmed):
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


def _iou(box_a, box_b):
    """Intersection-over-union of two (x1,y1,x2,y2) boxes, 0.0 if disjoint."""
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    return inter / (area_a + area_b - inter)


class VehicleTracker:
    """
    Associates per-frame vehicle detections (detect_plate_from_frame's
    list output, Session 7) into persistent per-vehicle tracks via
    frame-to-frame IoU matching, so PlateConfirmationTracker's
    similarity-based clustering runs independently per physical vehicle
    instead of pooling every vehicle seen in a stream into one shared
    set of clusters -- SIMILARITY_THRESHOLD=0.7 is permissive enough
    that two different real plates from two different vehicles could
    otherwise merge if they're superficially similar strings.

    Approach 1 from ALPR_IMPROVEMENT_LOG.md Session 7's design (tried
    first per instructions): greedy best-IoU matching against each
    track's last-seen box, no new dependency. Known risk, stated in the
    design before testing: process_video_file/process_stream only
    examine every Nth frame, so real displacement between *processed*
    frames is larger than true frame-to-frame motion -- this is
    exactly the condition IoU matching is weakest under. See Session 7
    for whether this held up on the real dashcam clip's actual sampling
    rate.
    """
    IOU_MATCH_THRESHOLD = 0.3
    MAX_MISSED_FRAMES = 5

    def __init__(self, window_size=10, confirm_threshold=2):
        self.window_size = window_size
        self.confirm_threshold = confirm_threshold
        self.tracks = []  # each: {"box": (x1,y1,x2,y2), "tracker": PlateConfirmationTracker, "missed": int}
        # Persists across track pruning -- a confirmed plate must not
        # silently disappear from the summary just because the vehicle
        # that produced it later left frame and its track got pruned.
        self.confirmed = set()

    def update(self, detections):
        """
        detections: detect_plate_from_frame's list output for one
        frame. Returns a list of confirmed-event dicts for this frame
        (0 or more -- one per vehicle track that just crossed its own
        confirm_threshold).
        """
        confirmed_events = []
        matched = set()

        for det in detections:
            box = det.get("box")
            if box is None:
                continue

            best_track, best_iou = None, 0.0
            for t in self.tracks:
                if id(t) in matched:
                    continue
                iou = _iou(t["box"], box)
                if iou >= self.IOU_MATCH_THRESHOLD and iou > best_iou:
                    best_track, best_iou = t, iou

            if best_track is None:
                best_track = {
                    "box": box,
                    "tracker": PlateConfirmationTracker(
                        window_size=self.window_size, confirm_threshold=self.confirm_threshold
                    ),
                    "missed": 0,
                }
                self.tracks.append(best_track)

            best_track["box"] = box
            best_track["missed"] = 0
            matched.add(id(best_track))

            plate = det.get("plate_number")
            if not plate:
                continue
            confirmed = best_track["tracker"].add(plate, det["confidence"], det["note"])
            if confirmed:
                confirmed_events.append(confirmed)
                self.confirmed.add(confirmed["plate_number"])

        for t in self.tracks:
            if id(t) not in matched:
                t["missed"] += 1
        self.tracks = [t for t in self.tracks if t["missed"] <= self.MAX_MISSED_FRAMES]

        return confirmed_events


def preprocess_for_ocr(img):
    """
    Upscales small crops and boosts local contrast (CLAHE) before OCR.
    Helps with distant/motion-blurred plates where raw OCR confidence
    is too low to pass filtering, even though the text is genuinely there.

    NOT CURRENTLY CALLED: was tuned for EasyOCR. PaddleOCR (the current
    OCR engine, see _ocr_readtext()) crashes on this function's
    single-channel grayscale output and, per testing, doesn't need this
    preprocessing anyway. Kept, not deleted, in case a future engine
    swap needs it again or a low-light/small-plate benchmark shows
    PaddleOCR needs help this function could still provide.
    """
    h, w = img.shape[:2]
    if max(h, w) < 300:
        scale = 300 / max(h, w)
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    return enhanced

LOW_LIGHT_BRIGHTNESS_THRESHOLD = 50


def is_low_light(img):
    """
    Cheap (grayscale mean, no denoising) brightness check, so the
    expensive enhance_low_light() below only runs on frames that
    actually need it. Threshold calibrated directly against our own
    data, not guessed: the 3 clean ground-truth images measure
    97-119 mean brightness; their synthetically darkened counterparts
    measure 25-29; fog/glare variants measure 131-159 (brighter than
    clean, not darker). 50 sits in the middle of a wide, cleanly
    separated gap between the darkest normal frame and the brightest
    dark one in every case tested so far.
    """
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).mean() < LOW_LIGHT_BRIGHTNESS_THRESHOLD


def enhance_low_light(img):
    """
    Denoise-then-CLAHE (LAB L-channel) for low-light frames. Tested
    directly against the reason low-light detection was failing:
    plain gamma correction and CLAHE-alone both left YOLO finding zero
    vehicles in a synthetically darkened+noisy test frame (see
    ALPR_IMPROVEMENT_LOG.md Session 5) -- CLAHE alone amplifies sensor
    noise rather than recovering real detail. Denoising first, then
    CLAHE, recovered a real vehicle detection (0 -> 0.288 confidence),
    and didn't regress the 3 clean ground-truth images (still 3/3 at
    1.0 confidence with it applied).

    Gated behind is_low_light() in detect_plate_from_frame, not called
    unconditionally -- fastNlMeansDenoisingColored is expensive enough
    that applying it to every frame (including well-lit ones that don't
    need it) measured a 2.5-3.6x end-to-end slowdown on the dashcam
    video regression (168-280s -> 608s for the same clip, Session 5).
    Gating it behind a cheap brightness check (Session 6) should
    recover the accuracy benefit on genuinely dark frames without
    paying that cost on the (presumably far more common) well-lit ones
    -- see ALPR_IMPROVEMENT_LOG.md Session 6 for the actual measured
    result on real video, not just the reasoning.
    """
    denoised = cv2.fastNlMeansDenoisingColored(img, None, 10, 10, 7, 21)
    lab = cv2.cvtColor(denoised, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    l2 = clahe.apply(l)
    return cv2.cvtColor(cv2.merge((l2, a, b)), cv2.COLOR_LAB2BGR)


BLUR_LAPLACIAN_VARIANCE_THRESHOLD = 250

# Unlike low-light (a genuinely frame-wide property), motion blur is
# per-vehicle -- it depends on that specific vehicle's relative motion
# to the camera, not overall scene brightness. Checked per vehicle crop
# in _read_plate_from_box(), not once per frame like is_low_light().


def is_blurry(img):
    """
    Laplacian-variance blur heuristic, threshold calibrated against our
    own data (Session 10), not guessed: the 3 clean ground-truth images
    measure 685-1061; their synthetically motion-blurred counterparts
    measure 196-225 -- a clean gap. The one real risk found: fog-degraded
    images measure 279.8, closer to the blur range than to clean --
    250 sits below fog's value so fog doesn't trigger this gate (fog
    isn't motion blur, and NAFNet was only validated against motion
    blur), but the margin against fog specifically is real, not huge,
    and this is a whole-crop average so it can still be fooled by a
    partly-sharp, partly-blurred crop. Flagged as a real limitation,
    not asserted as fully robust.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return cv2.Laplacian(gray, cv2.CV_64F).var() < BLUR_LAPLACIAN_VARIANCE_THRESHOLD


_NAFNET_CACHE_DIR = os.path.expanduser("~/.cache/netra_nafnet")
_NAFNET_CHECKPOINT_PATH = os.path.join(_NAFNET_CACHE_DIR, "NAFNet-GoPro-width32.pth")
# Verified in Session 9 as a genuine direct download (HTTP redirect to a
# real CDN, matching Content-Length, no login wall) -- a community
# HuggingFace mirror of the official megvii-research checkpoint. Not
# committed to git (68MB); fetched once and cached on first use, same
# pattern PaddleOCR's own models already follow in this pipeline.
_NAFNET_CHECKPOINT_URL = "https://huggingface.co/nyanko7/nafnet-models/resolve/main/NAFNet-GoPro-width32.pth"

_nafnet_model = None


def _get_nafnet_model():
    """Lazily loads and caches the NAFNet model (CPU) on first use, not
    at module import time -- most streams/images never hit the blur
    gate, so the ~68MB checkpoint fetch and model construction shouldn't
    cost anything unless a frame actually needs deblurring."""
    global _nafnet_model
    if _nafnet_model is not None:
        return _nafnet_model

    from nafnet.NAFNet_arch import NAFNetLocal

    if not os.path.exists(_NAFNET_CHECKPOINT_PATH):
        os.makedirs(_NAFNET_CACHE_DIR, exist_ok=True)
        print(f"[nafnet] downloading checkpoint to {_NAFNET_CHECKPOINT_PATH} ...")
        response = requests.get(_NAFNET_CHECKPOINT_URL, timeout=60)
        response.raise_for_status()
        with open(_NAFNET_CHECKPOINT_PATH, "wb") as f:
            f.write(response.content)

    model = NAFNetLocal(
        img_channel=3, width=32, enc_blk_nums=[1, 1, 1, 28], middle_blk_num=1,
        dec_blk_nums=[1, 1, 1, 1], train_size=(1, 3, 256, 256), fast_imp=True,
    )
    checkpoint = torch.load(_NAFNET_CHECKPOINT_PATH, map_location="cpu")
    model.load_state_dict(checkpoint["params"])
    model.eval()
    _nafnet_model = model
    return model


def enhance_motion_blur(img):
    """
    Runs the vendored NAFNet (nafnet/) on a blurry crop. Session 9
    measured 0/3 -> 1/3 exact matches on the synthetic motion-blur
    benchmark, no regression on clean images, ~0.4-1.1s/image on CPU --
    real evidence, not a guess, but only tested against a synthetic
    15px box-kernel blur there; re-verified against real footage in
    Session 10 (see ALPR_IMPROVEMENT_LOG.md).
    """
    model = _get_nafnet_model()
    img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype("float32") / 255.0
    tensor = torch.from_numpy(img_rgb).permute(2, 0, 1).unsqueeze(0)
    with torch.no_grad():
        out = model(tensor)
    out = out.squeeze(0).permute(1, 2, 0).clamp(0, 1).numpy()
    return cv2.cvtColor((out * 255).astype("uint8"), cv2.COLOR_RGB2BGR)


def plate_region_crop(vehicle_img):
    """
    Real plates sit in a fairly predictable band of a vehicle's bounding
    box: lower-middle, not the very bottom (bumper/road) or top
    (windshield/hood/grille badge). For a distant or angled vehicle, the
    plate is a tiny fraction of the full vehicle crop, so EasyOCR ends up
    searching mostly irrelevant pixels (badges, mirrors, grille) at low
    effective resolution. Narrowing to this band before OCR raises the
    fraction of real plate pixels in what gets upscaled and read.
    """
    h, w = vehicle_img.shape[:2]
    y1, y2 = int(0.55 * h), int(0.92 * h)
    x1, x2 = int(0.12 * w), int(0.90 * w)
    if y2 - y1 < 10 or x2 - x1 < 20:
        return None
    return vehicle_img[y1:y2, x1:x2]


MIN_VEHICLE_BOX_AREA_FRACTION = 0.03


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

    ocr_results = _ocr_readtext(vehicle_img)

    # Second pass on the plate's likely band within the vehicle box — a
    # much higher plate-pixel-density crop than the whole vehicle, so it
    # catches plates the whole-crop pass is too low-signal to read. Kept
    # additive (not a replacement) so a mislocalized crop can't cost us
    # a detection the whole-crop pass would still have found.
    region = plate_region_crop(vehicle_img)
    if region is not None and region.size > 0:
        ocr_results += _ocr_readtext(region)

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
            candidates.append((cleaned, conf))
        elif (corrected := _correct_plate_positions(cleaned)) is not None:
            candidates.append((corrected, conf))
        elif '.' not in text and 6 <= len(cleaned) <= 12 and cleaned[:2].isalpha() \
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
    coordinates) so stateful callers (see VehicleTracker) can associate
    detections into per-vehicle tracks across frames -- this function
    itself stays stateless and per-frame.

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
    results = yolo_model(enhance_low_light(infer_frame) if frame_is_dark else infer_frame, verbose=False)
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
                area = (raw_box[2] - raw_box[0]) * (raw_box[3] - raw_box[1])
                if area >= min_area:
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

            for confirmed in tracker.update(results):
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

        for confirmed in tracker.update(results):
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

            for confirmed in tracker.update(results):
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