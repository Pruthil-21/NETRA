"""Data Console traffic entities (Phase 3, backend-watchlist-owned data
exported through backend-registry's job engine): plate_sightings,
traffic_alerts, traffic_density, traffic_flows. All four read
watchlist-owned tables (detections, traffic_alerts) directly by table
name -- same physical Postgres instance, same convention reports_service
already uses -- so these tests insert into those tables directly via
get_conn() rather than going through backend-watchlist's own API."""
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from app.config import settings
from app.db import get_conn


def _headers(permissions, role="district_command", sub="traffic-dc-test"):
    token = jwt.encode(
        {"sub": sub, "badge_number": f"GJ-{sub}", "role": role,
         "scope_type": "platform", "scope_value": None, "permissions": permissions},
        settings.jwt_secret, algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def _admin_headers():
    return _headers(["view_analytics"])


def _random_plate():
    return f"GJ01DC{uuid.uuid4().hex[:4].upper()}"


def _insert_test_camera(dept: str, lat: float = 23.0, long: float = 72.5) -> int:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days) "
            "VALUES (%s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), 'fixed', 'govt', 'cloud', 30) RETURNING id",
            (f"Traffic DC Test Cam ({dept})", dept, long, lat),
        )
        camera_id = cur.fetchone()[0]
        conn.commit()
    return camera_id


def _delete_camera(camera_id: int):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM cameras WHERE id = %s", (camera_id,))
        conn.commit()


def _insert_detection(camera_id: int, plate: str, detected_at: datetime) -> int:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO detections (plate_number, camera_id, detected_at) VALUES (%s, %s, %s) RETURNING id",
            (plate, camera_id, detected_at),
        )
        detection_id = cur.fetchone()[0]
        conn.commit()
    return detection_id


def _delete_detections(ids: list[int]):
    if not ids:
        return
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM detections WHERE id = ANY(%s)", (ids,))
        conn.commit()


def _insert_traffic_alert(alert_type="density", camera_id=None, district=None, status="NEW") -> int:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO traffic_alerts (alert_type, camera_id, metric_value, threshold_value, district, status) "
            "VALUES (%s, %s, 99, 50, %s, %s) RETURNING id",
            (alert_type, camera_id, district, status),
        )
        alert_id = cur.fetchone()[0]
        conn.commit()
    return alert_id


def _delete_traffic_alerts(ids: list[int]):
    if not ids:
        return
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM traffic_alerts WHERE id = ANY(%s)", (ids,))
        conn.commit()


def test_new_traffic_entities_require_view_analytics_permission(client, data_job_test_rows):
    no_analytics = _headers(["manage_cameras"])
    for entity_type in ("plate_sightings", "traffic_alerts", "traffic_density", "traffic_flows"):
        resp = client.post(
            "/admin/data-jobs?direction=export",
            json={"entity_type": entity_type, "filters": {"window_minutes": 30}},
            headers=no_analytics,
        )
        assert resp.status_code == 403, entity_type


def test_plate_sightings_export_filters_by_camera_and_date(client, data_job_test_rows):
    cam = _insert_test_camera("Traffic DC Sightings District")
    now = datetime.now(timezone.utc)
    plate = _random_plate()
    detection_ids = [_insert_detection(cam, plate, now)]
    try:
        resp = client.post(
            "/admin/data-jobs?direction=export",
            json={"entity_type": "plate_sightings", "filters": {"camera_id": cam}},
            headers=_admin_headers(),
        )
        assert resp.status_code == 201
        data_job_test_rows.append(resp.json()["id"])
        rows = resp.json()["row_results"]
        assert any(r["plate_number"] == plate for r in rows)

        future_only = client.post(
            "/admin/data-jobs?direction=export",
            json={"entity_type": "plate_sightings", "filters": {"camera_id": cam, "date_from": "2999-01-01T00:00:00Z"}},
            headers=_admin_headers(),
        )
        data_job_test_rows.append(future_only.json()["id"])
        assert future_only.json()["row_results"] == []
    finally:
        _delete_detections(detection_ids)
        _delete_camera(cam)


def test_plate_sightings_export_filters_by_plate_number(client, data_job_test_rows):
    cam = _insert_test_camera("Traffic DC Plate District")
    now = datetime.now(timezone.utc)
    plate_a = _random_plate()
    plate_b = _random_plate()
    detection_ids = [_insert_detection(cam, plate_a, now), _insert_detection(cam, plate_b, now)]
    try:
        resp = client.post(
            "/admin/data-jobs?direction=export",
            json={"entity_type": "plate_sightings", "filters": {"plate_number": plate_a}},
            headers=_admin_headers(),
        )
        assert resp.status_code == 201
        data_job_test_rows.append(resp.json()["id"])
        plates = {r["plate_number"] for r in resp.json()["row_results"]}
        assert plate_a in plates
        assert plate_b not in plates
    finally:
        _delete_detections(detection_ids)
        _delete_camera(cam)


def test_traffic_alerts_export_filters_by_status_and_district(client, data_job_test_rows):
    own = _insert_traffic_alert(district="Traffic DC Alert District A", status="NEW")
    other_status = _insert_traffic_alert(district="Traffic DC Alert District A", status="DISMISSED")
    other_district = _insert_traffic_alert(district="Traffic DC Alert District B", status="NEW")
    try:
        resp = client.post(
            "/admin/data-jobs?direction=export",
            json={
                "entity_type": "traffic_alerts",
                "filters": {"status": "NEW", "district": "Traffic DC Alert District A"},
            },
            headers=_admin_headers(),
        )
        assert resp.status_code == 201
        data_job_test_rows.append(resp.json()["id"])
        ids = {r["id"] for r in resp.json()["row_results"]}
        assert own in ids
        assert other_status not in ids
        assert other_district not in ids
    finally:
        _delete_traffic_alerts([own, other_status, other_district])


def test_traffic_density_export_counts_within_the_live_window(client, data_job_test_rows):
    cam = _insert_test_camera("Traffic DC Density District")
    now = datetime.now(timezone.utc)
    detection_ids = [_insert_detection(cam, _random_plate(), now) for _ in range(3)]
    try:
        resp = client.post(
            "/admin/data-jobs?direction=export",
            json={
                "entity_type": "traffic_density",
                "filters": {"window_minutes": 30, "district": "Traffic DC Density District"},
            },
            headers=_admin_headers(),
        )
        assert resp.status_code == 201
        data_job_test_rows.append(resp.json()["id"])
        counts = {r["camera_id"]: r["count"] for r in resp.json()["row_results"]}
        assert counts.get(cam) == 3
    finally:
        _delete_detections(detection_ids)
        _delete_camera(cam)


def test_traffic_density_export_requires_exactly_one_window_param(client, data_job_test_rows):
    neither = client.post(
        "/admin/data-jobs?direction=export",
        json={"entity_type": "traffic_density", "filters": {}},
        headers=_admin_headers(),
    )
    assert neither.status_code == 400

    both = client.post(
        "/admin/data-jobs?direction=export",
        json={"entity_type": "traffic_density", "filters": {"window_minutes": 30, "hour": 5, "date": "2026-01-01"}},
        headers=_admin_headers(),
    )
    assert both.status_code == 400


def test_traffic_flows_export_counts_transitions_with_speed(client, data_job_test_rows):
    # ~1.11km apart with an exact 1-hour gap -- a known, checkable speed.
    cam_a = _insert_test_camera("Traffic DC Flow District", lat=23.0, long=72.5)
    cam_b = _insert_test_camera("Traffic DC Flow District", lat=23.01, long=72.5)
    plate = _random_plate()
    now = datetime.now(timezone.utc)
    detection_ids = [
        _insert_detection(cam_a, plate, now - timedelta(hours=1)),
        _insert_detection(cam_b, plate, now),
    ]
    try:
        resp = client.post(
            "/admin/data-jobs?direction=export",
            json={"entity_type": "traffic_flows", "filters": {"window_minutes": 180}},
            headers=_admin_headers(),
        )
        assert resp.status_code == 201
        data_job_test_rows.append(resp.json()["id"])
        flows = {
            (r["from_camera_id"], r["to_camera_id"]): r for r in resp.json()["row_results"]
        }
        flow = flows[(cam_a, cam_b)]
        assert flow["transitions"] == 1
        assert 1.0 < flow["avg_speed_kmh"] < 1.3  # ~1.11 km in 1h
    finally:
        _delete_detections(detection_ids)
        _delete_camera(cam_a)
        _delete_camera(cam_b)
