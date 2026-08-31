"""
Thin entry point for the ANPR pipeline -- the actual implementation lives
in anpr/ (config, ocr, plate_format, tracking, enhancement, detection,
watchlist_client, streaming). Kept as the stable, flat import surface
(`import detect_plate; detect_plate.X`) that vehicle_trace_demo.py and
ocr_gpu_worker.py already assume, and where the __main__ entry point
still lives.

Note for anyone extending anpr/detection.py: `_ocr_readtext` is looked up
dynamically through *this* module (`detect_plate._ocr_readtext(...)`) at
every call site, not imported statically, specifically so
vehicle_trace_demo.py's `detect_plate._ocr_readtext = <wrapper>`
monkeypatch continues to work. Don't "clean up" that indirection into a
plain `from .ocr import _ocr_readtext` without checking that first.
"""
import os
import sys

# Makes `anpr` importable regardless of caller cwd -- anpr/config.py does
# the same for the repo root (streaming/) and ml-anpr itself (nafnet/).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from anpr.config import DETECTION_API_URL, INTERNAL_KEY, CAMERA_ID_MAP, device, yolo_model  # noqa: E402,F401
from anpr.ocr import _ocr_readtext  # noqa: E402
from anpr.plate_format import (  # noqa: E402,F401
    INDIAN_PLATE_PATTERN, _correct_plate_positions, _edit_similarity,
    _containment_similarity, _plate_similarity,
)
from anpr.tracking import PlateConfirmationTracker, VehicleTracker  # noqa: E402,F401
from anpr.enhancement import (  # noqa: E402,F401
    LOW_LIGHT_BRIGHTNESS_THRESHOLD, is_low_light, enhance_low_light,
    BLUR_LAPLACIAN_VARIANCE_THRESHOLD, is_blurry, enhance_motion_blur,
)
from anpr.detection import (  # noqa: E402,F401
    plate_region_crop, detect_plate_from_frame, detect_plate,
    MIN_VEHICLE_BOX_AREA_FRACTION, LOW_CONFIDENCE_BOX_THRESHOLD, LOW_CONFIDENCE_BOX_EXPAND_FRACTION,
    MIN_VEHICLE_BOX_ASPECT_RATIO, MAX_VEHICLE_BOX_ASPECT_RATIO,
)
from anpr.watchlist_client import send_detection_to_watchlist  # noqa: E402,F401
from anpr.streaming import process_stream, process_video_file, process_hls_stream  # noqa: E402,F401

# Repo root is already on sys.path via anpr.config (imported above), so
# this resolves regardless of caller cwd.
from streaming.rtsp_reader import RTSPStreamReader  # noqa: E402,F401

# Everything above is re-exported for `import detect_plate; detect_plate.X`
# (vehicle_trace_demo.py and ocr_gpu_worker.py's docstrings both assume
# this flat surface) -- listed explicitly so static analysis doesn't flag
# the imports above as unused.
__all__ = [
    "DETECTION_API_URL", "INTERNAL_KEY", "CAMERA_ID_MAP", "device", "yolo_model",
    "_ocr_readtext",
    "INDIAN_PLATE_PATTERN", "_correct_plate_positions", "_edit_similarity",
    "_containment_similarity", "_plate_similarity",
    "PlateConfirmationTracker", "VehicleTracker",
    "LOW_LIGHT_BRIGHTNESS_THRESHOLD", "is_low_light", "enhance_low_light",
    "BLUR_LAPLACIAN_VARIANCE_THRESHOLD", "is_blurry", "enhance_motion_blur",
    "plate_region_crop", "detect_plate_from_frame", "detect_plate",
    "MIN_VEHICLE_BOX_AREA_FRACTION", "LOW_CONFIDENCE_BOX_THRESHOLD", "LOW_CONFIDENCE_BOX_EXPAND_FRACTION",
    "MIN_VEHICLE_BOX_ASPECT_RATIO", "MAX_VEHICLE_BOX_ASPECT_RATIO",
    "send_detection_to_watchlist",
    "process_stream", "process_video_file", "process_hls_stream",
    "RTSPStreamReader",
]


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
