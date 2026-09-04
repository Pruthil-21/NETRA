import uuid

import psycopg2
import psycopg2.extras
from app.config import settings


def _direct_conn():
    conn = psycopg2.connect(settings.database_url)
    conn.autocommit = True
    return conn


def _random_plate():
    return f"GJ01AB{uuid.uuid4().hex[:4].upper()}"


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


def _insert_test_camera(dept: str) -> int:
    """Creates a real, isolated camera row in a controlled department, so
    scoping tests never depend on what dept ambient seed data happens to
    have at some fixed id."""
    import psycopg2
    import psycopg2.extras
    from app.config import settings

    with psycopg2.connect(settings.database_url) as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days)
            VALUES (%s, %s, ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'fixed', 'govt', 'cloud', 30)
            RETURNING id
            """,
            (f"Scoping Test Cam ({dept})", dept),
        )
        camera_id = cur.fetchone()["id"]
        conn.commit()
    return camera_id


def _delete_test_camera(camera_id: int):
    import psycopg2
    from app.config import settings

    with psycopg2.connect(settings.database_url) as conn, conn.cursor() as cur:
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
