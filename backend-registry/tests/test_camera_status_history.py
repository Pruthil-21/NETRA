import os

import psycopg

NEW_CAMERA = {
    "name": "History Test Camera", "dept": "Traffic Police", "lat": 23.0,
    "long": 72.5, "camera_type": "ip", "ownership": "traffic-police",
    "connectivity_status": "online", "storage_type": "nvr",
    "retention_days": 15, "health_status": "healthy",
}


def _history_rows(camera_id):
    conn = psycopg.connect(os.environ["DATABASE_URL"])
    with conn.cursor() as cur:
        cur.execute(
            "SELECT connectivity_status FROM camera_status_history "
            "WHERE camera_id = %s ORDER BY changed_at",
            (camera_id,),
        )
        rows = [r[0] for r in cur.fetchall()]
    conn.close()
    return rows


def test_creating_a_camera_does_not_write_history(client, officer_headers):
    resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = resp.json()["id"]
    assert _history_rows(camera_id) == []


def test_changing_connectivity_status_writes_one_history_row(client, officer_headers):
    resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = resp.json()["id"]

    update_resp = client.put(
        f"/cameras/{camera_id}", json={"connectivity_status": "offline"}, headers=officer_headers
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["connectivity_status"] == "offline"
    assert _history_rows(camera_id) == ["offline"]


def test_setting_the_same_status_again_does_not_write_a_duplicate_row(client, officer_headers):
    resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = resp.json()["id"]

    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "offline"}, headers=officer_headers)
    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "offline"}, headers=officer_headers)

    assert _history_rows(camera_id) == ["offline"]


def test_multiple_real_transitions_are_all_recorded_in_order(client, officer_headers):
    resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = resp.json()["id"]

    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "offline"}, headers=officer_headers)
    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "online"}, headers=officer_headers)
    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "offline"}, headers=officer_headers)

    assert _history_rows(camera_id) == ["offline", "online", "offline"]


def test_updating_a_non_connectivity_field_does_not_write_history(client, officer_headers):
    resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = resp.json()["id"]

    client.put(f"/cameras/{camera_id}", json={"name": "Renamed Camera"}, headers=officer_headers)

    assert _history_rows(camera_id) == []


def test_connectivity_only_update_does_not_write_audit_log(client, officer_headers):
    from tests.test_audit_cleanup import _audit_count

    resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = resp.json()["id"]

    conn = psycopg.connect(os.environ["DATABASE_URL"])
    before = _audit_count(conn)

    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "offline"}, headers=officer_headers)

    after = _audit_count(conn)
    assert after == before, "connectivity-only PUT must not write to audit_logs (camera_status_history covers it)"
    conn.close()


def test_updating_a_real_field_still_writes_audit_log(client, officer_headers):
    from tests.test_audit_cleanup import _audit_count

    resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = resp.json()["id"]

    conn = psycopg.connect(os.environ["DATABASE_URL"])
    before = _audit_count(conn)

    client.put(f"/cameras/{camera_id}", json={"name": "Renamed Camera"}, headers=officer_headers)

    after = _audit_count(conn)
    assert after == before + 1, "a real admin edit must still write to audit_logs"
    conn.close()
