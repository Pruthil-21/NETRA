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

    # Regression check for the real bug this fix addresses: on a long run,
    # _recent_confirmations prunes itself down to nothing after
    # RECONFIRM_COOLDOWN_SEC, but confirmed_plates (the permanent record
    # streaming.py's final summary print reads) must still have every
    # plate ever confirmed this session -- simulate "long after" by
    # forcing the cooldown entry's timestamp into the past directly,
    # rather than a slow real sleep.
    assert PLATE in tracker.confirmed_plates, "confirmed_plates should permanently record every confirmed plate"
    for p in tracker._recent_confirmations:
        tracker._recent_confirmations[p] -= VehicleTracker.RECONFIRM_COOLDOWN_SEC + 1
    assert not tracker._recently_confirmed(PLATE), "cooldown entry should have expired"
    assert PLATE in tracker.confirmed_plates, "confirmed_plates must NOT be affected by cooldown pruning"

    print("OK: reconfirm within cooldown window suppressed, and confirmed_plates persists past cooldown expiry")
