import contextlib
import uuid
from datetime import datetime, timedelta, timezone

import jwt
import psycopg2
import psycopg2.extras
from app.config import settings
from app.services import traffic_alerts_service


def _direct_conn():
    conn = psycopg2.connect(settings.database_url)
    conn.autocommit = True
    return conn


def _random_plate():
    # See test_vehicle_traces.py's _random_plate() for why 4 hex chars of
    # suffix entropy is thin enough to risk a cross-test plate collision.
    return f"GJ01TA{uuid.uuid4().hex[:10].upper()}"


def _insert_test_camera(dept: str, lat: float = 23.0, long: float = 72.5) -> int:
    with contextlib.closing(psycopg2.connect(settings.database_url)) as conn, \
            conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days)
            VALUES (%s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), 'fixed', 'govt', 'cloud', 30)
            RETURNING id
            """,
            (f"Traffic Alert Test Cam ({dept})", dept, long, lat),
        )
        camera_id = cur.fetchone()["id"]
        conn.commit()
    return camera_id


def _delete_test_camera(camera_id: int):
    with contextlib.closing(psycopg2.connect(settings.database_url)) as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM cameras WHERE id = %s", (camera_id,))
        conn.commit()


def _make_token(role: str, scope_type: str, scope_value=None, permissions=None):
    if permissions is None:
        permissions = ["view_analytics", "acknowledge_alerts"]
    return jwt.encode(
        {"sub": "1", "badge_number": "TA-TEST", "role": role, "scope_type": scope_type,
         "scope_value": scope_value, "permissions": permissions},
        settings.jwt_secret, algorithm="HS256",
    )


def _run_evaluation_tick(traffic_alert_test_rows):
    """Direct call into evaluate_and_broadcast on a fresh connection --
    exercises the same code the background loop calls, without waiting on
    the real interval.

    evaluate_and_broadcast is deliberately network-wide (it's a system
    process, not scoped to one test's camera) -- a test that lowers a
    threshold enough to trip its own camera can just as easily trip real
    ambient traffic on other cameras already in this shared dev DB. Every
    id this tick creates, not just the one belonging to the test's own
    camera, must go into the cleanup fixture, or those ambient rows leak
    permanently (exactly the import_export_jobs leak from earlier this
    session, for the same underlying reason: an incomplete cleanup list)."""
    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        created = traffic_alerts_service.evaluate_and_broadcast(cur)
    traffic_alert_test_rows.extend(a["id"] for a in created)
    return created


def test_evaluate_creates_a_density_alert_when_the_threshold_is_crossed(
    client, internal_headers, traffic_alert_test_rows, monkeypatch
):
    monkeypatch.setattr(settings, "traffic_density_alert_threshold", 2)
    monkeypatch.setattr(settings, "traffic_alert_window_minutes", 30)
    cam = _insert_test_camera("Traffic Alert Density District")
    try:
        for _ in range(3):
            client.post(
                "/detections",
                json={"camera_id": cam, "plate_number": _random_plate()},
                headers=internal_headers,
            )

        created = _run_evaluation_tick(traffic_alert_test_rows)
        density_alerts = [a for a in created if a["alert_type"] == "density" and a["camera_id"] == cam]
        assert len(density_alerts) == 1
        assert density_alerts[0]["metric_value"] == 3
        assert density_alerts[0]["threshold_value"] == 2
        assert density_alerts[0]["status"] == "NEW"
        assert density_alerts[0]["district"] == "Traffic Alert Density District"
    finally:
        _delete_test_camera(cam)


def test_evaluate_respects_cooldown_and_does_not_duplicate_an_open_alert(
    client, internal_headers, traffic_alert_test_rows, monkeypatch
):
    monkeypatch.setattr(settings, "traffic_density_alert_threshold", 2)
    monkeypatch.setattr(settings, "traffic_alert_window_minutes", 30)
    monkeypatch.setattr(settings, "traffic_alert_cooldown_minutes", 30)
    cam = _insert_test_camera("Traffic Alert Cooldown District")
    try:
        for _ in range(3):
            client.post(
                "/detections",
                json={"camera_id": cam, "plate_number": _random_plate()},
                headers=internal_headers,
            )

        first = _run_evaluation_tick(traffic_alert_test_rows)
        first_for_cam = [a for a in first if a["camera_id"] == cam]
        assert len(first_for_cam) == 1

        second = _run_evaluation_tick(traffic_alert_test_rows)
        assert not [a for a in second if a["camera_id"] == cam]
    finally:
        _delete_test_camera(cam)


def test_evaluate_creates_a_flow_alert_when_speed_drops_below_threshold(
    client, internal_headers, traffic_alert_test_rows, monkeypatch
):
    # ~1.11km apart with a 2-hour gap -- a known, slow (~0.55 km/h) speed
    # that trips a generously-high congestion threshold without depending
    # on real-world data.
    monkeypatch.setattr(settings, "traffic_flow_congestion_speed_kmh", 5.0)
    monkeypatch.setattr(settings, "traffic_alert_window_minutes", 300)
    cam_a = _insert_test_camera("Traffic Alert Flow District", lat=23.0, long=72.5)
    cam_b = _insert_test_camera("Traffic Alert Flow District", lat=23.01, long=72.5)
    try:
        plate = _random_plate()
        now = datetime.now(timezone.utc)
        client.post(
            "/detections",
            json={"camera_id": cam_a, "plate_number": plate, "detected_at": (now - timedelta(hours=2)).isoformat()},
            headers=internal_headers,
        )
        client.post(
            "/detections",
            json={"camera_id": cam_b, "plate_number": plate, "detected_at": now.isoformat()},
            headers=internal_headers,
        )

        created = _run_evaluation_tick(traffic_alert_test_rows)
        flow_alerts = [
            a for a in created
            if a["alert_type"] == "flow" and a["from_camera_id"] == cam_a and a["to_camera_id"] == cam_b
        ]
        assert len(flow_alerts) == 1
        assert flow_alerts[0]["metric_value"] < 5.0
    finally:
        _delete_test_camera(cam_a)
        _delete_test_camera(cam_b)


def _set_camera_offline_since(camera_id: int, minutes_ago: float):
    with _direct_conn() as conn, conn.cursor() as cur:
        cur.execute("UPDATE cameras SET connectivity_status = 'offline' WHERE id = %s", (camera_id,))
        cur.execute(
            """
            INSERT INTO camera_status_history (camera_id, connectivity_status, changed_at)
            VALUES (%s, 'offline', now() - (%s || ' minutes')::interval)
            """,
            (camera_id, minutes_ago),
        )


def test_evaluate_creates_a_camera_offline_alert_past_the_threshold(client, traffic_alert_test_rows, monkeypatch):
    monkeypatch.setattr(settings, "camera_offline_alert_threshold_minutes", 10)
    cam = _insert_test_camera("Traffic Alert Offline District")
    try:
        _set_camera_offline_since(cam, 20)

        created = _run_evaluation_tick(traffic_alert_test_rows)
        offline_alerts = [a for a in created if a["alert_type"] == "camera_offline" and a["camera_id"] == cam]
        assert len(offline_alerts) == 1
        assert offline_alerts[0]["metric_value"] >= 10
        assert offline_alerts[0]["threshold_value"] == 10
        assert offline_alerts[0]["district"] == "Traffic Alert Offline District"
    finally:
        _delete_test_camera(cam)


def test_evaluate_does_not_alert_a_camera_offline_under_the_threshold(client, traffic_alert_test_rows, monkeypatch):
    monkeypatch.setattr(settings, "camera_offline_alert_threshold_minutes", 30)
    cam = _insert_test_camera("Traffic Alert Recent Offline District")
    try:
        _set_camera_offline_since(cam, 2)

        created = _run_evaluation_tick(traffic_alert_test_rows)
        assert not [a for a in created if a["camera_id"] == cam and a["alert_type"] == "camera_offline"]
    finally:
        _delete_test_camera(cam)


def test_evaluate_respects_cooldown_for_a_still_offline_camera(client, traffic_alert_test_rows, monkeypatch):
    monkeypatch.setattr(settings, "camera_offline_alert_threshold_minutes", 10)
    monkeypatch.setattr(settings, "traffic_alert_cooldown_minutes", 30)
    cam = _insert_test_camera("Traffic Alert Offline Cooldown District")
    try:
        _set_camera_offline_since(cam, 20)

        first = _run_evaluation_tick(traffic_alert_test_rows)
        assert [a for a in first if a["camera_id"] == cam and a["alert_type"] == "camera_offline"]

        second = _run_evaluation_tick(traffic_alert_test_rows)
        assert not [a for a in second if a["camera_id"] == cam and a["alert_type"] == "camera_offline"]
    finally:
        _delete_test_camera(cam)


def _insert_traffic_alert(alert_type="density", camera_id=None, district="Traffic Alert API District") -> int:
    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO traffic_alerts (alert_type, camera_id, metric_value, threshold_value, district)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
            """,
            (alert_type, camera_id, 99, 50, district),
        )
        return cur.fetchone()["id"]


def test_get_traffic_alerts_requires_view_analytics_permission(client, traffic_alert_test_rows):
    alert_id = _insert_traffic_alert()
    traffic_alert_test_rows.append(alert_id)
    token = _make_token("station_officer", "district", "Traffic Alert API District", permissions=["search_vehicles"])
    resp = client.get("/traffic-alerts", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403


def test_get_traffic_alerts_district_scoped_only_returns_own_district(client, traffic_alert_test_rows):
    own = _insert_traffic_alert(district="Traffic Alert API District A")
    traffic_alert_test_rows.append(own)
    other = _insert_traffic_alert(district="Traffic Alert API District B")
    traffic_alert_test_rows.append(other)

    token = _make_token("district_command", "district", "Traffic Alert API District A")
    resp = client.get("/traffic-alerts", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    ids = {row["id"] for row in resp.json()}
    assert own in ids
    assert other not in ids


def test_patch_traffic_alert_requires_acknowledge_alerts_permission(client, traffic_alert_test_rows):
    alert_id = _insert_traffic_alert()
    traffic_alert_test_rows.append(alert_id)
    token = _make_token("station_officer", "platform", permissions=["view_analytics"])
    resp = client.patch(
        f"/traffic-alerts/{alert_id}", json={"status": "ACKNOWLEDGED"}, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 403


def test_patch_traffic_alert_acknowledges_and_records_who(client, traffic_alert_test_rows):
    alert_id = _insert_traffic_alert()
    traffic_alert_test_rows.append(alert_id)
    token = _make_token("station_officer", "platform")
    resp = client.patch(
        f"/traffic-alerts/{alert_id}", json={"status": "ACKNOWLEDGED"}, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ACKNOWLEDGED"
    assert body["acknowledged_by"] == "TA-TEST"
    assert body["acknowledged_at"] is not None


def test_patch_traffic_alert_rejects_a_district_scoped_actor_outside_the_alerts_district(client, traffic_alert_test_rows):
    alert_id = _insert_traffic_alert(district="Traffic Alert Scope District")
    traffic_alert_test_rows.append(alert_id)
    token = _make_token("station_officer", "district", scope_value="Somewhere Else")
    resp = client.patch(
        f"/traffic-alerts/{alert_id}", json={"status": "ACKNOWLEDGED"}, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 403


def test_patch_traffic_alert_allows_a_district_scoped_actor_in_the_alerts_own_district(client, traffic_alert_test_rows):
    alert_id = _insert_traffic_alert(district="Traffic Alert Scope District")
    traffic_alert_test_rows.append(alert_id)
    token = _make_token("station_officer", "district", scope_value="Traffic Alert Scope District")
    resp = client.patch(
        f"/traffic-alerts/{alert_id}", json={"status": "ACKNOWLEDGED"}, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 200


def test_patch_traffic_alert_404_for_unknown_id(client, traffic_alert_test_rows):
    token = _make_token("station_officer", "platform")
    resp = client.patch(
        "/traffic-alerts/999999999", json={"status": "DISMISSED"}, headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 404
