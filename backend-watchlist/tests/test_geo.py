from datetime import datetime, timedelta, timezone

from app.services.geo import (
    EXTENDED_GAP,
    IMPROBABLE_SPEED,
    classify_leg_anomaly,
    haversine_km,
    initial_bearing_deg,
    leg_bearing_and_speed,
)


def test_haversine_km_known_distance():
    # Ahmedabad -> Gandhinagar, roughly 25km apart.
    dist = haversine_km(23.0225, 72.5714, 23.2156, 72.6369)
    assert 20 < dist < 30


def test_initial_bearing_due_north_is_zero():
    bearing = initial_bearing_deg(23.0, 72.0, 24.0, 72.0)
    assert bearing == 0


def test_initial_bearing_due_east_is_ninety():
    bearing = initial_bearing_deg(23.0, 72.0, 23.0, 73.0)
    assert 85 < bearing < 95


def test_leg_bearing_and_speed_computes_both():
    now = datetime.now(timezone.utc)
    prev = {"latitude": 22.4729, "longitude": 72.7938, "detected_at": now}
    curr = {"latitude": 22.4804, "longitude": 72.8051, "detected_at": now + timedelta(minutes=6)}
    bearing, speed = leg_bearing_and_speed(prev, curr)
    assert bearing is not None
    assert speed is not None
    assert speed > 0


def test_leg_bearing_and_speed_none_when_coordinates_missing():
    now = datetime.now(timezone.utc)
    prev = {"latitude": None, "longitude": None, "detected_at": now}
    curr = {"latitude": 22.48, "longitude": 72.80, "detected_at": now + timedelta(minutes=1)}
    assert leg_bearing_and_speed(prev, curr) == (None, None)


def test_leg_bearing_and_speed_no_speed_when_time_does_not_advance():
    now = datetime.now(timezone.utc)
    prev = {"latitude": 22.47, "longitude": 72.79, "detected_at": now}
    curr = {"latitude": 22.48, "longitude": 72.80, "detected_at": now}  # same timestamp
    bearing, speed = leg_bearing_and_speed(prev, curr)
    assert bearing is not None
    assert speed is None


def test_classify_leg_anomaly_flags_improbable_speed():
    assert classify_leg_anomaly(200.0, gap_hours=1.0) == IMPROBABLE_SPEED


def test_classify_leg_anomaly_flags_extended_gap():
    assert classify_leg_anomaly(40.0, gap_hours=20.0) == EXTENDED_GAP


def test_classify_leg_anomaly_improbable_speed_takes_priority_over_extended_gap():
    # A leg can trip both (a huge gap that also implies an impossible speed
    # if taken at face value) -- the more specific signal wins.
    assert classify_leg_anomaly(500.0, gap_hours=20.0) == IMPROBABLE_SPEED


def test_classify_leg_anomaly_none_for_a_normal_leg():
    assert classify_leg_anomaly(45.0, gap_hours=2.0) is None


def test_classify_leg_anomaly_none_when_speed_and_gap_are_both_unknown():
    assert classify_leg_anomaly(None, gap_hours=None) is None
