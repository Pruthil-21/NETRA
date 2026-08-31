import os

import psycopg


def _audit_count(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM audit_logs")
        return cur.fetchone()[0]


def test_list_cameras_does_not_write_audit_log(client, viewer_headers):
    conn = psycopg.connect(os.environ["DATABASE_URL"])
    before = _audit_count(conn)

    resp = client.get("/cameras", headers=viewer_headers)
    assert resp.status_code == 200

    after = _audit_count(conn)
    assert after == before, "GET /cameras must not write to audit_logs"
    conn.close()


def test_get_camera_does_not_write_audit_log(client, viewer_headers, officer_headers):
    conn = psycopg.connect(os.environ["DATABASE_URL"])

    create_resp = client.post(
        "/cameras",
        json={
            "name": "Audit Test Camera", "dept": "Traffic Police", "lat": 23.0,
            "long": 72.5, "camera_type": "ip", "ownership": "traffic-police",
            "connectivity_status": "online", "storage_type": "nvr",
            "retention_days": 15, "health_status": "healthy",
        },
        headers=officer_headers,
    )
    camera_id = create_resp.json()["id"]

    before = _audit_count(conn)
    resp = client.get(f"/cameras/{camera_id}", headers=viewer_headers)
    assert resp.status_code == 200
    after = _audit_count(conn)
    assert after == before, "GET /cameras/{id} must not write to audit_logs"
    conn.close()


def test_reports_summary_does_not_write_audit_log(client, viewer_headers):
    conn = psycopg.connect(os.environ["DATABASE_URL"])
    before = _audit_count(conn)

    resp = client.get("/reports/summary", headers=viewer_headers)
    assert resp.status_code == 200

    after = _audit_count(conn)
    assert after == before, "GET /reports/summary must not write to audit_logs"
    conn.close()


def test_create_camera_still_writes_audit_log(client, officer_headers):
    conn = psycopg.connect(os.environ["DATABASE_URL"])
    before = _audit_count(conn)

    resp = client.post(
        "/cameras",
        json={
            "name": "Audit Write Test", "dept": "Traffic Police", "lat": 23.0,
            "long": 72.5, "camera_type": "ip", "ownership": "traffic-police",
            "connectivity_status": "online", "storage_type": "nvr",
            "retention_days": 15, "health_status": "healthy",
        },
        headers=officer_headers,
    )
    assert resp.status_code == 201

    after = _audit_count(conn)
    assert after == before + 1, "POST /cameras (a real write) must still write to audit_logs"
    conn.close()
