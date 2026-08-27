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
        "/alerts",
        json={"camera_id": 1, "plate_number": plate},
        headers=internal_headers,
    )
    assert detect_resp.status_code == 201
    return detect_resp.json(), watchlist_id


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


def test_multiple_status_changes_append_multiple_rows(client, officer_headers, internal_headers):
    alert, _ = _seed_watchlist_and_detection(client, internal_headers)
    alert_id = alert["id"]

    for status in ("ACKNOWLEDGED", "ESCALATED", "DISMISSED"):
        resp = client.patch(f"/alerts/{alert_id}", json={"status": status}, headers=officer_headers)
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
