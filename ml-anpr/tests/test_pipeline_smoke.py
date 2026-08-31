"""Ground-truth smoke test: runs the real detect_plate() pipeline (YOLO +
NAFNet + PaddleOCR) end to end against three known images and checks the
exact plate text comes back. Not wired into a test runner (pytest etc) --
loads real models and takes real GPU/CPU time, so it's meant to be run
directly (`python tests/test_pipeline_smoke.py`) after any change to the
anpr/ package, not on every commit.
"""
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import detect_plate  # noqa: E402

TEST_IMAGES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "test_images"))

CASES = [
    ("car1.jpg", "MH48AW4023"),
    ("car2.jpg", "HR20AG3739"),
    ("car3.jpg", "MH20DV2366"),
]

if __name__ == "__main__":
    for fname, expected in CASES:
        path = os.path.join(TEST_IMAGES_DIR, fname)
        t0 = time.perf_counter()
        result = detect_plate.detect_plate(path)
        elapsed = (time.perf_counter() - t0) * 1000
        got = result.get("plate_number") if result else None
        conf = result.get("confidence") if result else None
        note = result.get("note") if result else None
        match = (got or "") == expected
        print(f"{fname:<12} expected={expected:<12} got={str(got):<12} conf={conf} "
              f"{elapsed:.0f}ms note={note} {'OK' if match else 'MISMATCH'}")
