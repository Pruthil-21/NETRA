"""Self-check for VehicleTracker's reconfirm cooldown (see
ALPR_IMPROVEMENT_LOG.md): a track that loses and re-acquires the same
physical vehicle (e.g. another car blocking it for a few frames) must not
log that plate a second time within RECONFIRM_COOLDOWN_SEC. Pure logic,
no models -- run directly: `python tests/test_reconfirm_cooldown.py`.
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from anpr.tracking import VehicleTracker  # noqa: E402

PLATE = "MH20DV2366"


def _det(box):
    return {"box": box, "plate_number": PLATE, "confidence": 0.9, "note": "ok - pattern match"}


if __name__ == "__main__":
    tracker = VehicleTracker(confirm_threshold=2)

    # Track A: same box twice -> confirms once.
    box_a = (0, 0, 100, 50)
    events = tracker.update([_det(box_a)])
    events += tracker.update([_det(box_a)])
    assert len(events) == 1, f"expected 1 confirm, got {len(events)}"

    # Track A blocked for longer than MAX_MISSED_FRAMES -> pruned.
    for _ in range(VehicleTracker.MAX_MISSED_FRAMES + 1):
        tracker.update([])

    # Track B: same plate re-acquired at a different box (a fresh track,
    # no memory of A) -- would confirm again on its own, but the camera-
    # level cooldown should suppress it since it's the same real plate
    # within RECONFIRM_COOLDOWN_SEC.
    box_b = (200, 200, 300, 250)
    events = tracker.update([_det(box_b)])
    events += tracker.update([_det(box_b)])
    assert len(events) == 0, f"expected reconfirm suppressed, got {len(events)} events"

    print("OK: reconfirm within cooldown window suppressed as expected")
