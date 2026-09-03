import uuid
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras
from app.config import settings
from app.services import detections_service


def _direct_conn():
    conn = psycopg2.connect(settings.database_url)
    conn.autocommit = True
    return conn


def _random_plate():
    return f"GJ01AB{uuid.uuid4().hex[:4].upper()}"


def test_single_detection_creates_one_summary_row_with_one_timestamp(client, internal_headers):
    plate = _random_plate()
    resp = client.post(
        "/detections",
        json={"camera_id": 101, "plate_number": plate},
        headers=internal_headers,
    )
    assert resp.status_code == 201
    detected_at = datetime.fromisoformat(resp.json()["detection"]["detected_at"])

    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT * FROM vehicle_daily_sightings WHERE camera_id = %s AND plate_number = %s",
            (101, plate),
        )
        row = cur.fetchone()
        assert row is not None
        assert len(row["detection_times"]) == 1
        assert row["detection_times"][0] == detected_at


def test_two_detections_same_camera_plate_day_append_to_same_row(client, internal_headers):
    plate = _random_plate()
    detected_ats = []
    for _ in range(2):
        resp = client.post(
            "/detections",
            json={"camera_id": 102, "plate_number": plate},
            headers=internal_headers,
        )
        assert resp.status_code == 201
        detected_ats.append(datetime.fromisoformat(resp.json()["detection"]["detected_at"]))

    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT * FROM vehicle_daily_sightings WHERE camera_id = %s AND plate_number = %s",
            (102, plate),
        )
        rows = cur.fetchall()
        assert len(rows) == 1
        assert len(rows[0]["detection_times"]) == 2
        assert sorted(rows[0]["detection_times"]) == sorted(detected_ats)


def test_two_different_cameras_same_plate_same_day_create_separate_rows(client, internal_headers):
    plate = _random_plate()
    for camera_id in (103, 104):
        resp = client.post(
            "/detections",
            json={"camera_id": camera_id, "plate_number": plate},
            headers=internal_headers,
        )
        assert resp.status_code == 201

    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT camera_id FROM vehicle_daily_sightings WHERE plate_number = %s ORDER BY camera_id",
            (plate,),
        )
        rows = cur.fetchall()
        assert [r["camera_id"] for r in rows] == [103, 104]


def test_day_boundary_is_ist_not_utc():
    plate = _random_plate()
    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        # 23:59 IST on 2026-09-03 == 18:29 UTC on 2026-09-03
        detections_service._upsert_daily_sighting(
            cur, 105, plate, datetime(2026, 9, 3, 18, 29, 0, tzinfo=timezone.utc)
        )
        # 00:01 IST on 2026-09-04 == 18:31 UTC on 2026-09-03
        detections_service._upsert_daily_sighting(
            cur, 105, plate, datetime(2026, 9, 3, 18, 31, 0, tzinfo=timezone.utc)
        )
        cur.execute(
            "SELECT sighting_date FROM vehicle_daily_sightings "
            "WHERE camera_id = %s AND plate_number = %s ORDER BY sighting_date",
            (105, plate),
        )
        rows = cur.fetchall()
        assert [r["sighting_date"].isoformat() for r in rows] == ["2026-09-03", "2026-09-04"]
