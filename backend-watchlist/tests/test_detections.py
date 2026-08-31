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
