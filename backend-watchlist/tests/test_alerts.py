import uuid

import psycopg2
import psycopg2.extras
from app.config import settings


def _direct_conn():
    conn = psycopg2.connect(settings.database_url)
    conn.autocommit = True
    return conn


def _seed_watchlist_and_detection(client, internal_headers):
    plate = f"GJ01AB{uuid.uuid4().hex[:4].upper()}"
    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "INSERT INTO watchlist (plate_number, reason, dept_flagged) VALUES (%s, %s, %s) RETURNING id",
            (plate, "test reason", "Traffic Police"),
        )
        watchlist_id = cur.fetchone()["id"]

    detect_resp = client.post(
        "/detections",
        json={"camera_id": 1, "plate_number": plate},
        headers=internal_headers,
    )
    assert detect_resp.status_code == 201
    result = detect_resp.json()
    assert result["alert"] is not None
    return result["alert"], watchlist_id


def test_status_update_is_append_only_not_a_mutation(client, officer_headers, internal_headers):
    alert, _ = _seed_watchlist_and_detection(client, internal_headers)
    alert_id = alert["id"]
    assert alert["status"] == "NEW"

    patch_resp = client.patch(
        f"/alerts/{alert_id}",
        json={"status": "ACKNOWLEDGED"},
        headers=officer_headers,
    )
    assert patch_resp.status_code == 200
    assert patch_resp.json()["status"] == "ACKNOWLEDGED"

    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT status FROM alerts WHERE id = %s", (alert_id,))
        raw_alert = cur.fetchone()
        assert raw_alert["status"] == "NEW", "alerts.status must never be mutated"

        cur.execute(
            "SELECT status FROM alert_status_history WHERE alert_id = %s ORDER BY id",
            (alert_id,),
        )
        history = cur.fetchall()
        assert [row["status"] for row in history] == ["ACKNOWLEDGED"]

    list_resp = client.get("/alerts", headers=officer_headers)
    listed = next(a for a in list_resp.json() if a["id"] == alert_id)
    assert listed["status"] == "ACKNOWLEDGED"


def test_multiple_status_changes_append_multiple_rows(client, officer_headers, second_officer_headers, internal_headers):
    alert, _ = _seed_watchlist_and_detection(client, internal_headers)
    alert_id = alert["id"]

    # ESCALATED is done by a second officer: Separation of Duty (spec Section
    # 6) blocks the officer who already acted on this alert (ACKNOWLEDGED)
    # from also being the one who escalates it.
    headers_by_status = {
        "ACKNOWLEDGED": officer_headers,
        "ESCALATED": second_officer_headers,
        "DISMISSED": officer_headers,
    }
    for status in ("ACKNOWLEDGED", "ESCALATED", "DISMISSED"):
        resp = client.patch(f"/alerts/{alert_id}", json={"status": status}, headers=headers_by_status[status])
        assert resp.status_code == 200
        assert resp.json()["status"] == status

    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT status FROM alert_status_history WHERE alert_id = %s ORDER BY id", (alert_id,)
        )
        history = cur.fetchall()
        assert [row["status"] for row in history] == ["ACKNOWLEDGED", "ESCALATED", "DISMISSED"]


def test_status_update_missing_alert_404(client, officer_headers):
    resp = client.patch("/alerts/999999", json={"status": "ACKNOWLEDGED"}, headers=officer_headers)
    assert resp.status_code == 404


def test_require_role_accepts_rbac_role_names(client):
    import jwt
    from app.config import settings

    for rbac_role in ["super_admin", "district_command", "station_officer", "control_room_operator", "auditor"]:
        token = jwt.encode({"sub": "rbac-test", "role": rbac_role}, settings.jwt_secret, algorithm="HS256")
        resp = client.get("/alerts", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200, f"role {rbac_role} was rejected"


def test_alert_includes_nearest_station(client, internal_headers):
    with psycopg2.connect(settings.database_url) as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS long FROM cameras WHERE id = 1")
        cam = cur.fetchone()
        cur.execute(
            "INSERT INTO police_stations (name, location, district) "
            "VALUES (%s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), 'Traffic Police') RETURNING id",
            ("Test Nearby Station", cam["long"], cam["lat"]),
        )
        station_id = cur.fetchone()["id"]
        conn.commit()

    try:
        # _seed_watchlist_and_detection (defined above) already produces a
        # real matched alert against camera_id 1 -- the same camera used
        # above -- via the watchlist-insert + POST /detections flow this
        # file's other tests exercise, so it's reused here rather than
        # duplicating that flow with a POST /watchlist call this file
        # doesn't otherwise use.
        alert, _ = _seed_watchlist_and_detection(client, internal_headers)
        assert alert["nearest_station"]["name"] == "Test Nearby Station"
        assert alert["nearest_station"]["distance_meters"] < 50
    finally:
        with psycopg2.connect(settings.database_url) as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM police_stations WHERE id = %s", (station_id,))
            conn.commit()


def test_alert_nearest_station_is_none_with_zero_stations():
    """Uses a transaction that is explicitly rolled back, never committed --
    must never actually delete real police_stations data (see this session's
    incident history with unscoped DELETEs on shared tables). Calls
    alerts_service._with_nearest_station DIRECTLY on the same connection the
    delete ran on, rather than through a live HTTP round-trip -- the running
    app process uses its own separate pooled connection, which would never
    see an uncommitted delete from a different connection, so an HTTP-based
    version of this test could not actually observe the "zero stations"
    condition at all."""
    from app.services import alerts_service

    conn = psycopg2.connect(settings.database_url)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("DELETE FROM police_stations")
            # camera_id 1 is expected to exist in this environment's seed data.
            alert = {"camera_id": 1}
            result = alerts_service._with_nearest_station(cur, alert)
            assert result["nearest_station"] is None
    finally:
        conn.rollback()
        conn.close()
