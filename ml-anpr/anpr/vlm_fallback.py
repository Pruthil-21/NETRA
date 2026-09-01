"""BLPR-style confidence-gated VLM fallback: a last-resort plate read via a
local Ollama vision model, used only for vehicle tracks that leave frame
without ever confirming through PlateConfirmationTracker's normal OCR
voting. See ALPR_IMPROVEMENT_LOG.md for the full design rationale --
briefly: this fires once per track, only at the moment VehicleTracker is
about to prune it unconfirmed, so it can never touch or regress a track
that already confirmed normally (HR98E4959-style clean runs never reach
this path at all). Its result is deliberately kept out of
PlateConfirmationTracker's vote (a single VLM read injected into that
voting risks recreating the exact majority-vote-bias problem Session 16
already proved isn't fixable by weight tuning) -- instead a validated read
is surfaced as its own confirmed event, tagged with a distinct note so it
never silently blends into normal OCR-confirmed stats and never reaches
send_detection_to_watchlist's "ok - pattern match" gate by default.

Runs entirely on-machine via Ollama (no image or plate data leaves this
computer, no third-party API, no account/keys needed) -- see
ALPR_IMPROVEMENT_LOG.md for the measured latency (0.48s warm / 6.7s cold)
that makes the async dispatch in VehicleTracker mandatory rather than an
inline call here.
"""
import base64
import json
import re
import urllib.error
import urllib.request

import cv2

from .plate_format import INDIAN_PLATE_PATTERN, _correct_plate_positions

OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "gemma3:4b"
# Generous margin above the measured 6.7s cold-start (model not yet
# resident in memory) -- keep_alive=-1 below should make cold-starts rare
# in practice, but a hung/overloaded Ollama shouldn't be able to block a
# background thread forever.
OLLAMA_TIMEOUT_SEC = 20

# Fixed and deliberately conservative, not the model's own self-reported
# certainty -- VLM self-reported confidence is known to be poorly
# calibrated (noted in BLPR's own paper), so a made-up number from the
# model would be worse than a stated constant here.
VLM_FALLBACK_CONFIDENCE = 0.5

# Two-step, not a direct "read the plate" ask: a direct ask measurably
# hallucinates a plausible-looking plate number on crops with no plate
# visible at all (e.g. a vehicle's side profile) rather than declining --
# confirmed directly on this project's own dashcam_trimmed.mp4 regression
# clip, where a direct prompt fabricated 7 different fake-but-correctly-
# *formatted* plates (passing this module's own pattern validation) on 7
# crops that in fact show no plate whatsoever. Forcing an explicit
# presence judgment before any text extraction, and stating plainly that
# "no plate visible" is a common and fully expected answer, eliminated all
# 7 of those on the same clip while still reading the real plates
# correctly (see ALPR_IMPROVEMENT_LOG.md for the full before/after).
_PROMPT = (
    "You are checking a cropped vehicle photo for a visible license plate. "
    "Many of these crops do NOT contain any visible plate at all -- this is "
    "common and expected (side profile, obstructed, plate on the other "
    "side of the vehicle, etc). Guessing a plausible-looking plate number "
    "when none is actually visible is a serious error -- do not do this "
    "under any circumstances.\n\n"
    "Step 1: Is there an actual license plate with legible or partially "
    "legible characters visible anywhere in this image? Answer only YES "
    "or NO.\n"
    "Step 2: If and only if YES, read the plate's characters exactly as "
    "printed (2 letters, 1-2 digits, 1-3 letters, 4 digits -- Indian "
    "format). If NO, or if a plate is visible but no characters can be "
    "made out at all, respond with exactly: NONE\n\n"
    "Respond in exactly this format:\n"
    "PLATE_VISIBLE: <YES or NO>\n"
    "TEXT: <the plate text, or NONE>"
)


def _call_ollama(image_bgr):
    ok, buf = cv2.imencode(".jpg", image_bgr)
    if not ok:
        return None
    img_b64 = base64.b64encode(buf.tobytes()).decode()
    payload = {
        "model": OLLAMA_MODEL,
        "prompt": _PROMPT,
        "images": [img_b64],
        "stream": False,
        "options": {"temperature": 0.0},
        # Keep the model resident between calls -- avoids paying the
        # measured 6.7s cold-start reload on every subsequent fallback
        # call, at the cost of ~3.3GB of RAM held for the model.
        "keep_alive": -1,
    }
    req = urllib.request.Request(
        OLLAMA_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT_SEC) as resp:
            out = json.loads(resp.read())
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        # Ollama not installed/running/reachable, or a malformed response --
        # fail closed. This function must never raise into the caller's
        # background thread (VehicleTracker treats a None result as simply
        # "no fallback available this time", not an error).
        return None
    return out.get("response", "").strip()


_TEXT_LINE = re.compile(r'TEXT:\s*(.*)', re.IGNORECASE)
_VISIBLE_LINE = re.compile(r'PLATE_VISIBLE:\s*(YES|NO)', re.IGNORECASE)


def read_plate_vlm(image_bgr):
    """
    Last-resort plate read via a local Ollama VLM. Returns a
    (plate_number, confidence, note) tuple in the same shape
    detection._read_plate_from_box produces for a normal OCR reading, or
    None if no validated Indian-plate-shaped string could be produced --
    Ollama unreachable, the model judged no plate visible, its response
    didn't follow the expected structured format at all (treated as no
    result, not salvaged -- fail closed same as every other case here),
    or its answer doesn't survive the same pattern validation every other
    OCR reading already goes through in detection.py (reusing that logic
    rather than trusting the VLM's raw text directly).
    """
    raw = _call_ollama(image_bgr)
    if not raw:
        return None

    visible_match = _VISIBLE_LINE.search(raw)
    text_match = _TEXT_LINE.search(raw)
    if not visible_match or not text_match:
        return None
    if visible_match.group(1).upper() != "YES":
        return None

    text = text_match.group(1).strip()
    if not text or text.upper() == "NONE":
        return None

    cleaned = re.sub(r'[^A-Z0-9]', '', text.upper())
    if INDIAN_PLATE_PATTERN.match(cleaned):
        plate = cleaned
    else:
        plate = _correct_plate_positions(cleaned)

    if plate is None:
        return None
    return (plate, VLM_FALLBACK_CONFIDENCE, "ok - vlm fallback")
