import contextlib
import uuid

import psycopg2
import psycopg2.extras
import pytest
from app.config import settings


def _direct_conn():
    conn = psycopg2.connect(settings.database_url)
    conn.autocommit = True
    return conn


def _random_plate():
    # 10 hex chars, not 4 -- this exact "GJ01AB" prefix is shared with
    # several other test files' own _random_plate(), and 4 chars (65536
    # values) was thin enough across one CI run's combined draws to produce
    # real cross-test plate collisions; see test_vehicle_traces.py's
    # _random_plate() for the full explanation of how that actually broke
    # an unrelated assertion there.
    return f"GJ01AB{uuid.uuid4().hex[:10].upper()}"


def test_post_detection_requires_internal_key(client):
    resp = client.post("/detections", json={"camera_id": 1, "plate_number": _random_plate()})
    assert resp.status_code == 422  # missing X-Internal-Key header


def test_post_detection_rejects_wrong_internal_key(client):
    resp = client.post(
        "/detections",
        json={"camera_id": 1, "plate_number": _random_plate()},
        headers={"X-Internal-Key": "wrong-key"},
    )
    assert resp.status_code == 401


def test_non_matching_plate_is_recorded_but_no_alert(client, internal_headers):
    plate = _random_plate()
    resp = client.post(
        "/detections",
        json={"camera_id": 1, "plate_number": plate, "confidence": 0.82},
        headers=internal_headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["alert"] is None
    assert body["detection"]["plate_number"] == plate
    assert body["detection"]["camera_id"] == 1
    assert body["detection"]["confidence"] == 0.82

    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT * FROM alerts WHERE plate_number = %s", (plate,))
        assert cur.fetchone() is None


def test_watchlist_match_creates_linked_detection_and_alert(client, internal_headers):
    plate = _random_plate()
    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "INSERT INTO watchlist (plate_number, reason, dept_flagged) VALUES (%s, %s, %s) RETURNING id",
            (plate, "test reason", "Traffic Police"),
        )
        watchlist_id = cur.fetchone()["id"]

    resp = client.post(
        "/detections",
        json={"camera_id": 3, "plate_number": plate},
        headers=internal_headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["alert"]["watchlist_id"] == watchlist_id
    assert body["alert"]["detection_id"] == body["detection"]["id"]


def test_get_detections_requires_auth(client):
    resp = client.get("/detections")
    assert resp.status_code == 401


def test_search_detections_by_plate(client, officer_headers, internal_headers):
    plate = _random_plate()
    client.post(
        "/detections",
        json={"camera_id": 5, "plate_number": plate},
        headers=internal_headers,
    )
    resp = client.get("/detections", params={"plate_number": plate}, headers=officer_headers)
    assert resp.status_code == 200
    results = resp.json()
    assert len(results) == 1
    assert results[0]["plate_number"] == plate
    assert results[0]["camera_id"] == 5


def test_search_detections_by_camera_id(client, officer_headers, internal_headers):
    plate = _random_plate()
    client.post(
        "/detections",
        json={"camera_id": 9, "plate_number": plate},
        headers=internal_headers,
    )
    resp = client.get("/detections", params={"camera_id": 9}, headers=officer_headers)
    assert resp.status_code == 200
    assert any(d["plate_number"] == plate for d in resp.json())


def test_reposting_the_same_event_id_returns_the_original_detection_not_a_duplicate(client, internal_headers):
    # The actual condition a retrying client hits: a timeout on the first
    # attempt, then the identical payload resent -- the server must return
    # the SAME detection, not create a second row.
    plate = _random_plate()
    event_id = str(uuid.uuid4())
    body = {"camera_id": 1, "plate_number": plate, "confidence": 0.9, "event_id": event_id}

    first = client.post("/detections", json=body, headers=internal_headers)
    second = client.post("/detections", json=body, headers=internal_headers)

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["detection"]["id"] == second.json()["detection"]["id"]

    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT COUNT(*) AS n FROM detections WHERE event_id = %s", (event_id,))
        assert cur.fetchone()["n"] == 1


def test_reposting_the_same_event_id_returns_the_original_alert_not_a_second_one(client, internal_headers):
    # The case Avi's request specifically calls out: a retried POST must not
    # create a second alert for the same underlying detection either.
    plate = _random_plate()
    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "INSERT INTO watchlist (plate_number, reason, dept_flagged) VALUES (%s, %s, %s) RETURNING id",
            (plate, "test reason", "Traffic Police"),
        )
        watchlist_id = cur.fetchone()["id"]

    event_id = str(uuid.uuid4())
    body = {"camera_id": 2, "plate_number": plate, "event_id": event_id}

    first = client.post("/detections", json=body, headers=internal_headers)
    second = client.post("/detections", json=body, headers=internal_headers)

    assert first.status_code == 201
    assert second.status_code == 201
    first_alert = first.json()["alert"]
    second_alert = second.json()["alert"]
    assert first_alert is not None
    assert first_alert["watchlist_id"] == watchlist_id
    assert second_alert is not None
    assert second_alert["id"] == first_alert["id"]  # same alert, not a new one

    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT COUNT(*) AS n FROM alerts WHERE plate_number = %s", (plate,))
        assert cur.fetchone()["n"] == 1


def test_different_event_ids_create_separate_detections(client, internal_headers):
    plate = _random_plate()
    first = client.post(
        "/detections",
        json={"camera_id": 1, "plate_number": plate, "event_id": str(uuid.uuid4())},
        headers=internal_headers,
    )
    second = client.post(
        "/detections",
        json={"camera_id": 1, "plate_number": plate, "event_id": str(uuid.uuid4())},
        headers=internal_headers,
    )
    assert first.json()["detection"]["id"] != second.json()["detection"]["id"]


def test_omitting_event_id_is_unaffected_no_dedup(client, internal_headers):
    # Live ml-anpr detections that don't yet send event_id must behave
    # exactly as before this change -- no accidental dedup.
    plate = _random_plate()
    first = client.post("/detections", json={"camera_id": 1, "plate_number": plate}, headers=internal_headers)
    second = client.post("/detections", json={"camera_id": 1, "plate_number": plate}, headers=internal_headers)
    assert first.json()["detection"]["id"] != second.json()["detection"]["id"]


def test_event_id_is_echoed_back_in_the_response(client, internal_headers):
    plate = _random_plate()
    event_id = str(uuid.uuid4())
    resp = client.post(
        "/detections",
        json={"camera_id": 1, "plate_number": plate, "event_id": event_id},
        headers=internal_headers,
    )
    assert resp.json()["detection"]["event_id"] == event_id


# Role-accurate permission lists for the RBAC roles this test file mints
# tokens for, matching backend-registry/scripts/seed_rbac.py's PERMISSIONS
# table for these roles. A real login-issued token always carries the
# role's actual permissions, so a hand-built test token needs to as well --
# has_permission() has no fallback for an empty/missing permissions claim.
_RBAC_ROLE_PERMISSIONS = {
    "super_admin": [
        "view_live_feeds", "search_vehicles", "edit_watchlist", "manage_cameras",
        "view_analytics", "export_data", "manage_users_roles", "view_audit_logs",
        "acknowledge_alerts", "manage_roles",
    ],
    "district_command": [
        "view_live_feeds", "search_vehicles", "edit_watchlist", "manage_cameras",
        "view_analytics", "export_data", "manage_users_roles", "acknowledge_alerts",
    ],
    "station_officer": [
        "view_live_feeds", "search_vehicles", "edit_watchlist", "acknowledge_alerts",
    ],
}


def _make_rbac_token(role: str, scope_type: str, scope_value=None, badge_number="TEST-001", permissions=None):
    import jwt
    from app.config import settings

    if permissions is None:
        permissions = _RBAC_ROLE_PERMISSIONS.get(role, [])

    return jwt.encode(
        {
            "sub": "1", "badge_number": badge_number, "name": "Test Officer",
            "role": role, "scope_type": scope_type, "scope_value": scope_value,
            "permissions": permissions,
        },
        settings.jwt_secret, algorithm="HS256",
    )


def _insert_test_camera(dept: str, lat: float = 23.0, long: float = 72.5) -> int:
    """Creates a real, isolated camera row in a controlled department, so
    scoping tests never depend on what dept ambient seed data happens to
    have at some fixed id. lat/long default to a fixed point (every prior
    caller's behavior, unchanged); flow tests override them to control the
    distance between two cameras precisely."""
    import psycopg2
    import psycopg2.extras
    from app.config import settings

    with contextlib.closing(psycopg2.connect(settings.database_url)) as conn, \
            conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days)
            VALUES (%s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), 'fixed', 'govt', 'cloud', 30)
            RETURNING id
            """,
            (f"Scoping Test Cam ({dept})", dept, long, lat),
        )
        camera_id = cur.fetchone()["id"]
        conn.commit()
    return camera_id


def _delete_test_camera(camera_id: int):
    import psycopg2
    from app.config import settings

    with contextlib.closing(psycopg2.connect(settings.database_url)) as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM cameras WHERE id = %s", (camera_id,))
        conn.commit()


def test_district_scoped_search_only_returns_own_district(client, internal_headers, scoping_test_cameras):
    cam_a = _insert_test_camera("Scoping Test District A")
    scoping_test_cameras.append(cam_a)
    cam_b = _insert_test_camera("Scoping Test District B")
    scoping_test_cameras.append(cam_b)
    plate_a = _random_plate()
    plate_b = _random_plate()
    client.post("/detections", json={"camera_id": cam_a, "plate_number": plate_a}, headers=internal_headers)
    client.post("/detections", json={"camera_id": cam_b, "plate_number": plate_b}, headers=internal_headers)

    token = _make_rbac_token("district_command", "district", "Scoping Test District A")
    resp = client.get("/detections", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    plates = [d["plate_number"] for d in resp.json()]
    assert plate_a in plates
    assert plate_b not in plates


def test_platform_scoped_search_sees_all_districts(client, internal_headers, scoping_test_cameras):
    cam = _insert_test_camera("Scoping Test District C")
    scoping_test_cameras.append(cam)
    plate = _random_plate()
    client.post("/detections", json={"camera_id": cam, "plate_number": plate}, headers=internal_headers)

    token = _make_rbac_token("super_admin", "platform")
    resp = client.get("/detections", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert any(d["plate_number"] == plate for d in resp.json())


def test_search_detections_requires_search_vehicles_permission(client):
    # GET /detections is gated by require_permission("search_vehicles") (the
    # final review fix wave replaced the over-permissive require_role("officer"),
    # which let every RBAC role name through regardless of its actual
    # permissions). control_room_operator has no search_vehicles per
    # seed_rbac.py's PERMISSIONS table, so it must be rejected -- proving the
    # permission gate is real, not just "is an RBAC role name."
    token = _make_rbac_token("control_room_operator", "platform", permissions=["view_live_feeds", "acknowledge_alerts"])
    resp = client.get("/detections", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403


def test_csv_export_requires_export_data_permission(client, internal_headers):
    plate = _random_plate()
    client.post("/detections", json={"camera_id": 1, "plate_number": plate}, headers=internal_headers)

    no_export_token = _make_rbac_token("station_officer", "district", "Traffic Police")
    resp = client.get("/detections?format=csv", headers={"Authorization": f"Bearer {no_export_token}"})
    assert resp.status_code == 403


def test_csv_export_returns_csv_with_matching_rows(client, internal_headers):
    plate = _random_plate()
    client.post("/detections", json={"camera_id": 1, "plate_number": plate}, headers=internal_headers)

    export_token = _make_rbac_token("district_command", "platform")
    resp = client.get(f"/detections?format=csv&plate_number={plate}", headers={"Authorization": f"Bearer {export_token}"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    lines = resp.text.strip().split("\r\n")
    assert lines[0] == "id,plate_number,camera_id,detected_at,confidence"
    assert len(lines) == 2  # header + 1 row
    assert plate in lines[1]


def test_density_requires_view_analytics_permission(client):
    # station_officer has search_vehicles but not view_analytics per
    # seed_rbac.py's PERMISSIONS table -- the density layer is gated
    # separately from plain plate search.
    token = _make_rbac_token("station_officer", "district", "Traffic Police")
    resp = client.get(
        "/detections/density", params={"window_minutes": 30}, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 403


def test_density_requires_exactly_one_window_param(client):
    token = _make_rbac_token("super_admin", "platform")
    headers = {"Authorization": f"Bearer {token}"}

    neither = client.get("/detections/density", headers=headers)
    assert neither.status_code == 400

    both = client.get("/detections/density", params={"window_minutes": 30, "hour": 5}, headers=headers)
    assert both.status_code == 400


def test_density_live_window_counts_recent_detections(client, internal_headers):
    plate = _random_plate()
    client.post("/detections", json={"camera_id": 7, "plate_number": plate}, headers=internal_headers)

    token = _make_rbac_token("super_admin", "platform")
    resp = client.get(
        "/detections/density", params={"window_minutes": 30}, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 200
    counts = {row["camera_id"]: row["count"] for row in resp.json()}
    assert counts.get(7, 0) >= 1


def test_density_hour_mode_counts_current_hour_bucket_only(client, internal_headers):
    from datetime import datetime
    from zoneinfo import ZoneInfo

    plate = _random_plate()
    client.post("/detections", json={"camera_id": 8, "plate_number": plate}, headers=internal_headers)

    now_ist = datetime.now(ZoneInfo("Asia/Kolkata"))
    token = _make_rbac_token("super_admin", "platform")
    headers = {"Authorization": f"Bearer {token}"}

    resp = client.get(
        "/detections/density",
        params={"hour": now_ist.hour, "date": now_ist.date().isoformat()},
        headers=headers,
    )
    assert resp.status_code == 200
    counts = {row["camera_id"]: row["count"] for row in resp.json()}
    assert counts.get(8, 0) >= 1

    other_hour = (now_ist.hour + 12) % 24
    resp_other = client.get(
        "/detections/density",
        params={"hour": other_hour, "date": now_ist.date().isoformat()},
        headers=headers,
    )
    assert 8 not in {row["camera_id"] for row in resp_other.json()}


def _insert_virtual_capture_camera(dept: str) -> int:
    """A Manual Plate Lookup dispatch target (cameras.is_virtual_capture) --
    never a real installed camera, so it must never contribute to density/
    flow analytics (see reports_service.get_summary and this file's density/
    flow query sites, all of which now filter is_virtual_capture = false)."""
    with contextlib.closing(psycopg2.connect(settings.database_url)) as conn, \
            conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type,
                                  retention_days, is_virtual_capture)
            VALUES (%s, %s, ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'mobile_handheld', 'department', 'none', 0, true)
            RETURNING id
            """,
            ("Virtual Capture Test Camera", dept),
        )
        return cur.fetchone()["id"]


def test_density_excludes_virtual_capture_cameras(client, internal_headers, scoping_test_cameras):
    real_cam = _insert_test_camera("Virtual Capture Density Test")
    scoping_test_cameras.append(real_cam)
    virtual_cam = _insert_virtual_capture_camera("Virtual Capture Density Test")
    scoping_test_cameras.append(virtual_cam)

    client.post("/detections", json={"camera_id": real_cam, "plate_number": _random_plate()}, headers=internal_headers)
    client.post("/detections", json={"camera_id": virtual_cam, "plate_number": _random_plate()}, headers=internal_headers)

    token = _make_rbac_token("super_admin", "platform")
    resp = client.get(
        "/detections/density", params={"window_minutes": 30}, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 200
    camera_ids = {row["camera_id"] for row in resp.json()}
    assert real_cam in camera_ids
    assert virtual_cam not in camera_ids


def test_density_district_scoped_only_counts_own_district(client, internal_headers, scoping_test_cameras):
    cam_a = _insert_test_camera("Scoping Test District A")
    scoping_test_cameras.append(cam_a)
    cam_b = _insert_test_camera("Scoping Test District B")
    scoping_test_cameras.append(cam_b)
    client.post("/detections", json={"camera_id": cam_a, "plate_number": _random_plate()}, headers=internal_headers)
    client.post("/detections", json={"camera_id": cam_b, "plate_number": _random_plate()}, headers=internal_headers)

    token = _make_rbac_token("district_command", "district", "Scoping Test District A")
    resp = client.get(
        "/detections/density",
        params={"window_minutes": 30},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    counted_ids = {row["camera_id"] for row in resp.json()}
    assert cam_a in counted_ids
    assert cam_b not in counted_ids


def test_flows_requires_view_analytics_permission(client):
    token = _make_rbac_token("station_officer", "district", "Traffic Police")
    resp = client.get(
        "/detections/flows", params={"window_minutes": 30}, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 403


def test_flows_requires_exactly_one_window_param(client):
    token = _make_rbac_token("super_admin", "platform")
    headers = {"Authorization": f"Bearer {token}"}

    neither = client.get("/detections/flows", headers=headers)
    assert neither.status_code == 400

    both = client.get("/detections/flows", params={"window_minutes": 30, "hour": 5}, headers=headers)
    assert both.status_code == 400


def test_flows_counts_a_transition_with_correct_average_speed(client, internal_headers, scoping_test_cameras):
    from datetime import datetime, timedelta, timezone

    from app.services import geo

    # ~1.11km apart (0.01 degrees latitude) with an exact 1-hour gap between
    # the two sightings -- gives a known, checkable speed rather than a
    # real-world value that could drift with unrelated seed data.
    cam_a = _insert_test_camera("Flow Test District", lat=23.0, long=72.5)
    scoping_test_cameras.append(cam_a)
    cam_b = _insert_test_camera("Flow Test District", lat=23.01, long=72.5)
    scoping_test_cameras.append(cam_b)
    expected_km = geo.haversine_km(23.0, 72.5, 23.01, 72.5)

    plate = _random_plate()
    now = datetime.now(timezone.utc)
    t_a = now - timedelta(hours=1)
    t_b = now
    client.post(
        "/detections",
        json={"camera_id": cam_a, "plate_number": plate, "detected_at": t_a.isoformat()},
        headers=internal_headers,
    )
    client.post(
        "/detections",
        json={"camera_id": cam_b, "plate_number": plate, "detected_at": t_b.isoformat()},
        headers=internal_headers,
    )

    token = _make_rbac_token("super_admin", "platform")
    resp = client.get(
        "/detections/flows", params={"window_minutes": 180}, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 200
    flows = {(row["from_camera_id"], row["to_camera_id"]): row for row in resp.json()}
    flow = flows[(cam_a, cam_b)]
    assert flow["transitions"] == 1
    assert flow["avg_speed_kmh"] == pytest.approx(expected_km, rel=0.02)


def test_flows_excludes_transitions_past_the_gap_cap(client, internal_headers, scoping_test_cameras):
    from datetime import datetime, timedelta, timezone

    cam_a = _insert_test_camera("Flow Test District")
    scoping_test_cameras.append(cam_a)
    cam_b = _insert_test_camera("Flow Test District")
    scoping_test_cameras.append(cam_b)

    plate = _random_plate()
    now = datetime.now(timezone.utc)
    t_a = now - timedelta(hours=4)  # past MAX_FLOW_TRANSITION_GAP_HOURS (3h)
    t_b = now
    client.post(
        "/detections",
        json={"camera_id": cam_a, "plate_number": plate, "detected_at": t_a.isoformat()},
        headers=internal_headers,
    )
    client.post(
        "/detections",
        json={"camera_id": cam_b, "plate_number": plate, "detected_at": t_b.isoformat()},
        headers=internal_headers,
    )

    token = _make_rbac_token("super_admin", "platform")
    resp = client.get(
        "/detections/flows", params={"window_minutes": 300}, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 200
    flows = {(row["from_camera_id"], row["to_camera_id"]) for row in resp.json()}
    assert (cam_a, cam_b) not in flows


def test_flows_district_scoped_only_counts_own_district(client, internal_headers, scoping_test_cameras):
    cam_a = _insert_test_camera("Flow Scoping District A", lat=23.0, long=72.5)
    scoping_test_cameras.append(cam_a)
    cam_b = _insert_test_camera("Flow Scoping District A", lat=23.01, long=72.5)
    scoping_test_cameras.append(cam_b)
    cam_c = _insert_test_camera("Flow Scoping District B", lat=23.0, long=72.5)
    scoping_test_cameras.append(cam_c)
    cam_d = _insert_test_camera("Flow Scoping District B", lat=23.01, long=72.5)
    scoping_test_cameras.append(cam_d)

    plate_ab = _random_plate()
    client.post("/detections", json={"camera_id": cam_a, "plate_number": plate_ab}, headers=internal_headers)
    client.post("/detections", json={"camera_id": cam_b, "plate_number": plate_ab}, headers=internal_headers)
    plate_cd = _random_plate()
    client.post("/detections", json={"camera_id": cam_c, "plate_number": plate_cd}, headers=internal_headers)
    client.post("/detections", json={"camera_id": cam_d, "plate_number": plate_cd}, headers=internal_headers)

    token = _make_rbac_token("district_command", "district", "Flow Scoping District A")
    resp = client.get(
        "/detections/flows", params={"window_minutes": 30}, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 200
    flows = {(row["from_camera_id"], row["to_camera_id"]) for row in resp.json()}
    assert (cam_a, cam_b) in flows
    assert (cam_c, cam_d) not in flows


def test_density_trend_requires_view_analytics_permission(client):
    token = _make_rbac_token("station_officer", "district", "Traffic Police")
    resp = client.get(
        "/detections/density/trend",
        params={"from": "2026-01-01T00:00:00Z", "to": "2026-01-02T00:00:00Z"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


def test_density_trend_rejects_a_range_where_to_is_not_after_from(client):
    token = _make_rbac_token("super_admin", "platform")
    resp = client.get(
        "/detections/density/trend",
        params={"from": "2026-01-02T00:00:00Z", "to": "2026-01-01T00:00:00Z"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 400


def test_density_trend_buckets_counts_by_day_and_ranks_top_cameras(client, internal_headers, scoping_test_cameras):
    from datetime import datetime, timedelta, timezone

    cam = _insert_test_camera("Trend Test District")
    scoping_test_cameras.append(cam)
    plate = _random_plate()
    now = datetime.now(timezone.utc)
    today = now - timedelta(hours=1)
    yesterday = now - timedelta(days=1, hours=1)
    for _ in range(3):
        client.post(
            "/detections",
            json={"camera_id": cam, "plate_number": plate, "detected_at": today.isoformat()},
            headers=internal_headers,
        )
    client.post(
        "/detections",
        json={"camera_id": cam, "plate_number": plate, "detected_at": yesterday.isoformat()},
        headers=internal_headers,
    )

    # District-scoped, not platform -- the shared dev DB has real ongoing
    # traffic from other districts/cameras that a platform-wide query would
    # pick up too, making an exact bucket-count assertion flaky.
    token = _make_rbac_token("district_command", "district", "Trend Test District")
    resp = client.get(
        "/detections/density/trend",
        params={
            "from": (now - timedelta(days=2)).isoformat(),
            "to": (now + timedelta(hours=1)).isoformat(),
            "bucket": "day",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["trend"]) == 2  # two distinct IST calendar days
    assert sum(b["count"] for b in body["trend"]) == 4
    top = {row["camera_id"]: row["count"] for row in body["top_cameras"]}
    assert top.get(cam) == 4


def test_flows_trend_requires_view_analytics_permission(client):
    token = _make_rbac_token("station_officer", "district", "Traffic Police")
    resp = client.get(
        "/detections/flows/trend",
        params={"from": "2026-01-01T00:00:00Z", "to": "2026-01-02T00:00:00Z"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


def test_flows_trend_ranks_top_corridors_with_speed(client, internal_headers, scoping_test_cameras):
    from datetime import datetime, timedelta, timezone

    from app.services import geo

    cam_a = _insert_test_camera("Flow Trend District", lat=23.0, long=72.5)
    scoping_test_cameras.append(cam_a)
    cam_b = _insert_test_camera("Flow Trend District", lat=23.01, long=72.5)
    scoping_test_cameras.append(cam_b)
    expected_km = geo.haversine_km(23.0, 72.5, 23.01, 72.5)

    plate = _random_plate()
    now = datetime.now(timezone.utc)
    t_a = now - timedelta(hours=2)
    t_b = now - timedelta(hours=1)
    client.post(
        "/detections",
        json={"camera_id": cam_a, "plate_number": plate, "detected_at": t_a.isoformat()},
        headers=internal_headers,
    )
    client.post(
        "/detections",
        json={"camera_id": cam_b, "plate_number": plate, "detected_at": t_b.isoformat()},
        headers=internal_headers,
    )

    # District-scoped, not platform -- isolates from real ongoing traffic
    # in the shared dev DB that would otherwise crowd this single-transition
    # corridor out of the top_corridors ranking.
    token = _make_rbac_token("district_command", "district", "Flow Trend District")
    resp = client.get(
        "/detections/flows/trend",
        params={
            "from": (now - timedelta(days=1)).isoformat(),
            "to": (now + timedelta(hours=1)).isoformat(),
            "bucket": "day",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert sum(b["count"] for b in body["trend"]) == 1
    corridors = {(row["from_camera_id"], row["to_camera_id"]): row for row in body["top_corridors"]}
    corridor = corridors[(cam_a, cam_b)]
    assert corridor["transitions"] == 1
    assert corridor["avg_speed_kmh"] == pytest.approx(expected_km, rel=0.02)


def test_flows_route_is_none_when_osrm_is_unavailable(client, internal_headers, scoping_test_cameras):
    # Under pytest, route_geometry_service skips the real network call
    # entirely (see its PYTEST_CURRENT_TEST guard) -- every flow's route
    # comes back None rather than making a live external HTTP call on every
    # test run. This is the "no regression" half of that guard; the
    # positive case (a route actually attached) is covered below by
    # mocking the fetch directly.
    cam_a = _insert_test_camera("Flow Route District", lat=23.0, long=72.5)
    scoping_test_cameras.append(cam_a)
    cam_b = _insert_test_camera("Flow Route District", lat=23.01, long=72.5)
    scoping_test_cameras.append(cam_b)

    plate = _random_plate()
    client.post("/detections", json={"camera_id": cam_a, "plate_number": plate}, headers=internal_headers)
    client.post("/detections", json={"camera_id": cam_b, "plate_number": plate}, headers=internal_headers)

    token = _make_rbac_token("super_admin", "platform")
    resp = client.get(
        "/detections/flows", params={"window_minutes": 30}, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 200
    flows = {(row["from_camera_id"], row["to_camera_id"]): row for row in resp.json()}
    assert flows[(cam_a, cam_b)]["route"] is None


def test_flows_attaches_a_road_route_when_osrm_resolves_one(
    client, internal_headers, scoping_test_cameras, monkeypatch
):
    from app.services import route_geometry_service

    fake_geometry = [[23.0, 72.5], [23.005, 72.502], [23.01, 72.5]]
    monkeypatch.setattr(
        route_geometry_service, "_fetch_route",
        lambda *a, **k: {"geometry": fake_geometry, "distance_meters": 1200.0, "duration_seconds": 240.0},
    )

    cam_a = _insert_test_camera("Flow Route Mocked District", lat=23.0, long=72.5)
    scoping_test_cameras.append(cam_a)
    cam_b = _insert_test_camera("Flow Route Mocked District", lat=23.01, long=72.5)
    scoping_test_cameras.append(cam_b)

    plate = _random_plate()
    client.post("/detections", json={"camera_id": cam_a, "plate_number": plate}, headers=internal_headers)
    client.post("/detections", json={"camera_id": cam_b, "plate_number": plate}, headers=internal_headers)

    # District-scoped, not platform -- _fetch_route is mocked globally for
    # this test, so a platform-wide query would also process (and cache
    # fake geometry against) any real ambient flow pairs already in the
    # shared dev DB, exactly the traffic_alerts leak fixed earlier this
    # session for the same underlying reason.
    token = _make_rbac_token("district_command", "district", "Flow Route Mocked District")
    resp = client.get(
        "/detections/flows", params={"window_minutes": 30}, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 200
    flows = {(row["from_camera_id"], row["to_camera_id"]): row for row in resp.json()}
    assert flows[(cam_a, cam_b)]["route"] == fake_geometry

    with _direct_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT geometry FROM flow_route_cache WHERE from_camera_id = %s AND to_camera_id = %s",
            (cam_a, cam_b),
        )
        cached = cur.fetchone()
        assert cached is not None
        cur.execute("DELETE FROM flow_route_cache WHERE from_camera_id = %s AND to_camera_id = %s", (cam_a, cam_b))
