import contextlib
import uuid
from datetime import datetime, timedelta, timezone

import psycopg2
import psycopg2.extras
import pytest
from app.config import settings
from app.services import camera_metadata


def _random_plate():
    # 10 hex chars, not 4 -- this exact "GJ01AB" prefix is reused by several
    # other test files' own _random_plate() (test_detections.py,
    # test_watchlist.py, test_vehicle_daily_sightings.py, test_alerts.py),
    # all drawing from the same shared namespace in one CI run. At 4 chars
    # (65536 values) across the 40+ draws that namespace sees per run, plate
    # collisions between unrelated tests were a real, if rare, occurrence --
    # and a big one: a collided plate merges two tests' detections into one
    # vehicle-traces query, and if the other test's camera was already
    # cleaned up by its own fixture teardown, camera_metadata.lookup()
    # correctly returns None for that foreign sighting, which can land at
    # sightings[0] and fail an assertion that has nothing wrong with it.
    return f"GJ01AB{uuid.uuid4().hex[:10].upper()}"


def _direct_conn():
    conn = psycopg2.connect(settings.database_url)
    conn.autocommit = True
    return conn


def _insert_test_camera(name: str, lat: float, lon: float) -> int:
    with contextlib.closing(_direct_conn()) as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days, stream_id)
            VALUES (%s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), 'fixed', 'govt', 'cloud', 30, %s)
            RETURNING id
            """,
            (name, "Vehicle Trace Test", lon, lat, name),
        )
        return cur.fetchone()["id"]


@pytest.fixture
def trace_test_cameras():
    created_ids: list[int] = []
    yield created_ids
    if created_ids:
        with contextlib.closing(_direct_conn()) as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM cameras WHERE id = ANY(%s)", (created_ids,))


def _make_token(role="officer", permissions=("search_vehicles",), sub="test-officer", badge_number=None):
    import jwt

    payload = {"sub": sub, "role": role}
    if badge_number is not None:
        payload["badge_number"] = badge_number
    if permissions is not None:
        payload["permissions"] = list(permissions)
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def test_requires_search_vehicles_permission_for_rbac_tokens(client):
    # An RBAC-issued token (carries an explicit permissions claim) without
    # search_vehicles must be rejected -- mirrors GET /detections' own gate.
    token = _make_token(role="control_room_operator", permissions=["view_live_feeds"])
    resp = client.get("/vehicle-traces/GJ01AB1234", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403


def test_officer_token_without_permissions_claim_is_rejected(client):
    # A bare {"role": "officer"} token with no permissions claim at all used
    # to be treated as fully trusted (a live, unconditional auth bypass --
    # anyone who could craft any token in this shape got full access, no
    # real permissions required). require_permission no longer special-cases
    # this shape: no permissions claim means no permissions.
    token = _make_token(role="officer", permissions=None)
    resp = client.get("/vehicle-traces/GJ01AB1234", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403


def test_trace_uses_real_registered_camera_coordinates(client, internal_headers, trace_test_cameras):
    cam_id = _insert_test_camera("Trace Test Cam", 22.4729, 72.7938)
    trace_test_cameras.append(cam_id)
    plate = _random_plate()
    client.post("/detections", json={"camera_id": cam_id, "plate_number": plate}, headers=internal_headers)

    resp = client.get(f"/vehicle-traces/{plate}", headers={"Authorization": f"Bearer {_make_token()}"})
    assert resp.status_code == 200
    sighting = resp.json()["sightings"][0]
    assert sighting["camera_name"] == "Trace Test Cam"
    assert sighting["latitude"] == pytest.approx(22.4729, abs=1e-4)
    assert sighting["longitude"] == pytest.approx(72.7938, abs=1e-4)


def test_trace_falls_back_to_demo_camera_for_unregistered_ids(client, internal_headers):
    # 101 is one of the hardcoded vehicle-trace-demo cameras in
    # camera_metadata.py and (in a from-scratch test DB) has no real row in
    # `cameras` -- exercises the fallback branch directly against
    # camera_metadata.lookup rather than depending on that being true of
    # whatever cameras happen to be seeded in this environment.
    with contextlib.closing(_direct_conn()) as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT id FROM cameras WHERE id = 101")
        already_registered = cur.fetchone() is not None
        result = camera_metadata.lookup(cur, 101)

    if already_registered:
        pytest.skip("camera id 101 is a real registered camera in this environment")
    assert result["camera_name"] == "Petlad Entry Checkpoint"


def test_trace_date_range_filters_out_sightings_outside_the_window(client, internal_headers, trace_test_cameras):
    cam_id = _insert_test_camera("Date Range Test Cam", 22.47, 72.79)
    trace_test_cameras.append(cam_id)
    plate = _random_plate()

    old_ts = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    recent_ts = datetime.now(timezone.utc).isoformat()
    client.post(
        "/detections",
        json={"camera_id": cam_id, "plate_number": plate, "detected_at": old_ts},
        headers=internal_headers,
    )
    client.post(
        "/detections",
        json={"camera_id": cam_id, "plate_number": plate, "detected_at": recent_ts},
        headers=internal_headers,
    )

    window_start = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    resp = client.get(
        f"/vehicle-traces/{plate}",
        params={"from": window_start},
        headers={"Authorization": f"Bearer {_make_token()}"},
    )
    assert resp.status_code == 200
    sightings = resp.json()["sightings"]
    assert len(sightings) == 1


def test_trace_computes_bearing_and_speed_between_consecutive_sightings(client, internal_headers, trace_test_cameras):
    cam_a = _insert_test_camera("Leg Start Cam", 22.4729, 72.7938)
    cam_b = _insert_test_camera("Leg End Cam", 22.4804, 72.8051)
    trace_test_cameras += [cam_a, cam_b]
    plate = _random_plate()

    t0 = datetime.now(timezone.utc)
    client.post(
        "/detections",
        json={"camera_id": cam_a, "plate_number": plate, "detected_at": t0.isoformat()},
        headers=internal_headers,
    )
    client.post(
        "/detections",
        json={"camera_id": cam_b, "plate_number": plate, "detected_at": (t0 + timedelta(minutes=6)).isoformat()},
        headers=internal_headers,
    )

    resp = client.get(f"/vehicle-traces/{plate}", headers={"Authorization": f"Bearer {_make_token()}"})
    sightings = resp.json()["sightings"]
    assert sightings[0]["bearing_deg"] is None
    assert sightings[0]["speed_kmh"] is None
    assert sightings[1]["bearing_deg"] is not None
    assert sightings[1]["speed_kmh"] is not None
    assert sightings[1]["speed_kmh"] > 0


def test_trace_flags_improbable_speed_between_cameras_too_far_apart_too_fast(
    client, internal_headers, trace_test_cameras
):
    # ~110km apart (Ahmedabad -> Vadodara-ish distance) in 6 minutes implies
    # over 1000 km/h -- well past MAX_PLAUSIBLE_SPEED_KMH, so this should be
    # flagged as a likely OCR mismatch rather than a real drive.
    cam_a = _insert_test_camera("Far Cam A", 23.0225, 72.5714)
    cam_b = _insert_test_camera("Far Cam B", 22.3072, 73.1812)
    trace_test_cameras += [cam_a, cam_b]
    plate = _random_plate()

    t0 = datetime.now(timezone.utc)
    client.post(
        "/detections",
        json={"camera_id": cam_a, "plate_number": plate, "detected_at": t0.isoformat()},
        headers=internal_headers,
    )
    client.post(
        "/detections",
        json={"camera_id": cam_b, "plate_number": plate, "detected_at": (t0 + timedelta(minutes=6)).isoformat()},
        headers=internal_headers,
    )

    resp = client.get(f"/vehicle-traces/{plate}", headers={"Authorization": f"Bearer {_make_token()}"})
    sightings = resp.json()["sightings"]
    assert sightings[0]["anomaly"] is None
    assert sightings[1]["anomaly"] == "improbable_speed"


def test_trace_flags_extended_gap_between_sightings(client, internal_headers, trace_test_cameras):
    cam_id = _insert_test_camera("Gap Test Cam", 22.47, 72.79)
    trace_test_cameras.append(cam_id)
    plate = _random_plate()

    t0 = datetime.now(timezone.utc) - timedelta(days=1)
    client.post(
        "/detections",
        json={"camera_id": cam_id, "plate_number": plate, "detected_at": t0.isoformat()},
        headers=internal_headers,
    )
    client.post(
        "/detections",
        json={"camera_id": cam_id, "plate_number": plate, "detected_at": (t0 + timedelta(hours=18)).isoformat()},
        headers=internal_headers,
    )

    resp = client.get(f"/vehicle-traces/{plate}", headers={"Authorization": f"Bearer {_make_token()}"})
    sightings = resp.json()["sightings"]
    assert sightings[1]["anomaly"] == "extended_gap"


def test_predict_next_camera_ranks_the_most_common_historical_transition(
    client, internal_headers, trace_test_cameras
):
    cam_start = _insert_test_camera("Predict Start Cam", 22.40, 72.70)
    cam_common = _insert_test_camera("Predict Common Next Cam", 22.41, 72.71)
    cam_rare = _insert_test_camera("Predict Rare Next Cam", 22.42, 72.72)
    trace_test_cameras += [cam_start, cam_common, cam_rare]

    t0 = datetime.now(timezone.utc)
    # Three different plates go start -> common; one goes start -> rare.
    for i in range(3):
        plate = _random_plate()
        client.post(
            "/detections",
            json={"camera_id": cam_start, "plate_number": plate, "detected_at": t0.isoformat()},
            headers=internal_headers,
        )
        client.post(
            "/detections",
            json={
                "camera_id": cam_common, "plate_number": plate,
                "detected_at": (t0 + timedelta(minutes=5)).isoformat(),
            },
            headers=internal_headers,
        )
    rare_plate = _random_plate()
    client.post(
        "/detections",
        json={"camera_id": cam_start, "plate_number": rare_plate, "detected_at": t0.isoformat()},
        headers=internal_headers,
    )
    client.post(
        "/detections",
        json={
            "camera_id": cam_rare, "plate_number": rare_plate,
            "detected_at": (t0 + timedelta(minutes=5)).isoformat(),
        },
        headers=internal_headers,
    )

    resp = client.get(
        f"/vehicle-traces/predict-next/{cam_start}", headers={"Authorization": f"Bearer {_make_token()}"}
    )
    assert resp.status_code == 200
    candidates = resp.json()["candidates"]
    assert candidates[0]["camera_id"] == cam_common
    assert candidates[0]["confidence"] == pytest.approx(0.75, abs=0.01)


def test_trace_response_embeds_predicted_next_from_the_last_sighting(
    client, internal_headers, trace_test_cameras
):
    cam_a = _insert_test_camera("Embedded Predict Cam A", 22.50, 72.80)
    cam_b = _insert_test_camera("Embedded Predict Cam B", 22.51, 72.81)
    trace_test_cameras += [cam_a, cam_b]
    plate = _random_plate()
    t0 = datetime.now(timezone.utc)

    # Establish a network-wide pattern (a different plate) from cam_a -> cam_b...
    other_plate = _random_plate()
    client.post(
        "/detections",
        json={"camera_id": cam_a, "plate_number": other_plate, "detected_at": t0.isoformat()},
        headers=internal_headers,
    )
    client.post(
        "/detections",
        json={"camera_id": cam_b, "plate_number": other_plate, "detected_at": (t0 + timedelta(minutes=5)).isoformat()},
        headers=internal_headers,
    )
    # ...then trace a plate whose only sighting so far is cam_a.
    client.post(
        "/detections",
        json={"camera_id": cam_a, "plate_number": plate, "detected_at": t0.isoformat()},
        headers=internal_headers,
    )

    resp = client.get(f"/vehicle-traces/{plate}", headers={"Authorization": f"Bearer {_make_token()}"})
    predicted = resp.json()["predicted_next"]
    assert len(predicted) == 1
    assert predicted[0]["camera_id"] == cam_b


def test_trace_query_is_audited(client, internal_headers, trace_test_cameras):
    cam_id = _insert_test_camera("Audit Test Cam", 22.47, 72.79)
    trace_test_cameras.append(cam_id)
    plate = _random_plate()
    client.post("/detections", json={"camera_id": cam_id, "plate_number": plate}, headers=internal_headers)

    resp = client.get(
        f"/vehicle-traces/{plate}",
        headers={"Authorization": f"Bearer {_make_token(badge_number='GJ-AUDIT-001')}"},
    )
    assert resp.status_code == 200

    with contextlib.closing(_direct_conn()) as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT * FROM audit_logs WHERE resource_type = 'vehicle_trace' AND reason_code = %s "
            "ORDER BY id DESC LIMIT 1",
            (plate,),
        )
        row = cur.fetchone()
    assert row is not None
    assert row["action"] == "search"
    assert row["badge_number"] == "GJ-AUDIT-001"
