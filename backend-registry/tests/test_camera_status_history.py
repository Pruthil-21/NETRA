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


def test_creating_a_camera_does_not_write_history(client, officer_headers, gap_analysis_test_cameras):
    resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = resp.json()["id"]
    gap_analysis_test_cameras.append(camera_id)
    assert _history_rows(camera_id) == []


def test_changing_connectivity_status_writes_one_history_row(client, officer_headers, gap_analysis_test_cameras):
    resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = resp.json()["id"]
    gap_analysis_test_cameras.append(camera_id)

    update_resp = client.put(
        f"/cameras/{camera_id}", json={"connectivity_status": "offline"}, headers=officer_headers
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["connectivity_status"] == "offline"
    assert _history_rows(camera_id) == ["offline"]


def test_setting_the_same_status_again_does_not_write_a_duplicate_row(
    client, officer_headers, gap_analysis_test_cameras
):
    resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = resp.json()["id"]
    gap_analysis_test_cameras.append(camera_id)

    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "offline"}, headers=officer_headers)
    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "offline"}, headers=officer_headers)

    assert _history_rows(camera_id) == ["offline"]


def test_multiple_real_transitions_are_all_recorded_in_order(client, officer_headers, gap_analysis_test_cameras):
    resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = resp.json()["id"]
    gap_analysis_test_cameras.append(camera_id)

    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "offline"}, headers=officer_headers)
    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "online"}, headers=officer_headers)
    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "offline"}, headers=officer_headers)

    assert _history_rows(camera_id) == ["offline", "online", "offline"]


def test_updating_a_non_connectivity_field_does_not_write_history(
    client, officer_headers, gap_analysis_test_cameras
):
    resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = resp.json()["id"]
    gap_analysis_test_cameras.append(camera_id)

    client.put(f"/cameras/{camera_id}", json={"name": "Renamed Camera"}, headers=officer_headers)

    assert _history_rows(camera_id) == []


def _latest_audit_row(conn, camera_id):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT badge_number, action, reason_code FROM audit_logs "
            "WHERE resource_type = 'camera' AND resource_id = %s ORDER BY id DESC LIMIT 1",
            (camera_id,),
        )
        return cur.fetchone()


def test_connectivity_only_update_writes_a_system_attributed_audit_log(
    client, officer_headers, gap_analysis_test_cameras
):
    from tests.test_audit_cleanup import _audit_count

    resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = resp.json()["id"]
    gap_analysis_test_cameras.append(camera_id)

    conn = psycopg.connect(os.environ["DATABASE_URL"])
    before = _audit_count(conn)

    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "offline"}, headers=officer_headers)

    after = _audit_count(conn)
    assert after == before + 1, "a connectivity transition must write its own audit_logs entry"
    badge_number, action, reason_code = _latest_audit_row(conn, camera_id)
    assert action == "camera_offline"
    # "system", not the officer whose browser happened to have the PUT open --
    # a health-check-driven status flip isn't something that officer DID.
    assert badge_number == "system"
    # No prior camera_status_history row exists yet for a brand-new camera,
    # so there's nothing to measure a held-duration against.
    assert reason_code is None
    conn.close()


def test_a_later_transition_reports_how_long_the_previous_status_held(
    client, officer_headers, gap_analysis_test_cameras
):
    resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = resp.json()["id"]
    gap_analysis_test_cameras.append(camera_id)

    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "offline"}, headers=officer_headers)

    conn = psycopg.connect(os.environ["DATABASE_URL"])
    # Backdate the row the PUT above just inserted, so "how long did it hold"
    # has something real to measure instead of a near-zero test-runtime gap.
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE camera_status_history SET changed_at = now() - interval '45 minutes' "
            "WHERE camera_id = %s",
            (camera_id,),
        )
        conn.commit()

    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "online"}, headers=officer_headers)

    _, action, reason_code = _latest_audit_row(conn, camera_id)
    assert action == "camera_online"
    assert reason_code == "was offline for 45m"
    conn.close()


def test_updating_a_real_field_still_writes_audit_log(client, officer_headers, gap_analysis_test_cameras):
    from tests.test_audit_cleanup import _audit_count

    resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = resp.json()["id"]
    gap_analysis_test_cameras.append(camera_id)

    conn = psycopg.connect(os.environ["DATABASE_URL"])
    before = _audit_count(conn)

    client.put(f"/cameras/{camera_id}", json={"name": "Renamed Camera"}, headers=officer_headers)

    after = _audit_count(conn)
    assert after == before + 1, "a real admin edit must still write to audit_logs"
    conn.close()
