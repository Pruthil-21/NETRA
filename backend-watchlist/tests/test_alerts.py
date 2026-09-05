import uuid

import psycopg2
import psycopg2.extras
from app.config import settings


def _direct_conn():
    conn = psycopg2.connect(settings.database_url)
    conn.autocommit = True
    return conn


def _seed_watchlist_and_detection(client, internal_headers, camera_id=1):
    plate = f"GJ01AB{uuid.uuid4().hex[:4].upper()}"
    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "INSERT INTO watchlist (plate_number, reason, dept_flagged) VALUES (%s, %s, %s) RETURNING id",
            (plate, "test reason", "Traffic Police"),
        )
        watchlist_id = cur.fetchone()["id"]

    detect_resp = client.post(
        "/detections",
        json={"camera_id": camera_id, "plate_number": plate},
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


def test_alert_includes_nearest_station(client, internal_headers, scoping_test_cameras):
    # Camera id=1 isn't guaranteed to exist (e.g. a fresh CI database has
    # the schema but no seed data) -- create our own camera at a known
    # location instead of assuming one is already there.
    with psycopg2.connect(settings.database_url) as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days) "
            "VALUES ('Test Nearest-Station Camera', 'Traffic Police', "
            "ST_SetSRID(ST_MakePoint(72.6100, 23.1100), 4326), 'Bullet', 'Test Rig', 'Cloud', 0) "
            "RETURNING id, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS long",
        )
        cam = cur.fetchone()
        conn.commit()
    scoping_test_cameras.append(cam["id"])

    with psycopg2.connect(settings.database_url) as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "INSERT INTO police_stations (name, location, district) "
            "VALUES (%s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), 'Traffic Police') RETURNING id",
            ("Test Nearby Station", cam["long"], cam["lat"]),
        )
        station_id = cur.fetchone()["id"]
        conn.commit()

    try:
        # _seed_watchlist_and_detection (defined above) produces a real
        # matched alert against the camera created above.
        alert, _ = _seed_watchlist_and_detection(client, internal_headers, camera_id=cam["id"])
        assert alert["nearest_station"]["name"] == "Test Nearby Station"
        assert alert["nearest_station"]["distance_meters"] < 50
    finally:
        with psycopg2.connect(settings.database_url) as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM police_stations WHERE id = %s", (station_id,))
            conn.commit()


def test_police_stations_table_exists():
    """Guards against Finding 2: police_stations is owned by backend-registry
    and only auto-applies via docker-entrypoint-initdb.d on a fresh Postgres
    volume (see backend-registry/tests/test_coverage_targets.py's
    test_coverage_targets_table_exists for the exact precedent). alerts_service
    queries it cross-schema from backend-watchlist's own DB connection --
    _with_nearest_station now degrades gracefully if it's missing, but this
    test converts a missing migration into a named failure instead of a
    silent `nearest_station: null` on every alert."""
    with psycopg2.connect(settings.database_url) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = %s)",
            ("police_stations",),
        )
        exists = cur.fetchone()[0]
    assert exists, (
        "police_stations table is missing -- backend-registry's schema.sql was "
        "not applied to this Postgres instance (it only auto-runs via "
        "docker-entrypoint-initdb.d on a fresh volume). Apply the migration "
        "manually before running this suite."
    )


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
