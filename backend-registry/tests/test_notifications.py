"""Minimal in-app notification log (v2 spec, Phase D)."""
import os
import subprocess
import sys

BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(script):
    subprocess.run([sys.executable, script], check=True, cwd=BACKEND_ROOT)


def _seed():
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")


def _super_admin_headers(client):
    resp = client.post("/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"})
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def test_granting_a_posting_notifies_the_officer_and_they_can_read_and_mark_it(client):
    _seed()
    admin_headers = _super_admin_headers(client)
    officers = client.get("/admin/officers", headers=admin_headers).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")

    posting = client.post(
        "/admin/postings",
        json={"officer_id": target["id"], "role_name": "station_officer", "scope_type": "district", "scope_value": "Home / Police"},
        headers=admin_headers,
    ).json()

    officer_token = client.post(
        "/auth/login", json={"badge_number": "GJ-SO-001", "password": "demo-pass-station-officer"}
    ).json()["token"]
    officer_headers = {"Authorization": f"Bearer {officer_token}"}

    notifications = client.get("/notifications", headers=officer_headers).json()
    assert any(n["type"] == "role_granted" for n in notifications)
    unread = next(n for n in notifications if n["type"] == "role_granted")
    assert unread["read"] is False

    mark_resp = client.post(f"/notifications/{unread['id']}/read", headers=officer_headers)
    assert mark_resp.status_code == 204

    refreshed = client.get("/notifications?unread_only=true", headers=officer_headers).json()
    assert all(n["id"] != unread["id"] for n in refreshed)

    client.delete(f"/admin/postings/{posting['id']}", headers=admin_headers)


def test_mark_all_read_clears_unread_count_without_touching_others(client):
    _seed()
    admin_headers = _super_admin_headers(client)
    officers = client.get("/admin/officers", headers=admin_headers).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-DC-001")

    posting = client.post(
        "/admin/postings",
        json={"officer_id": target["id"], "role_name": "district_command", "scope_type": "district", "scope_value": "Home / Police"},
        headers=admin_headers,
    ).json()
    client.delete(f"/admin/postings/{posting['id']}", headers=admin_headers)

    officer_token = client.post(
        "/auth/login", json={"badge_number": "GJ-DC-001", "password": "demo-pass-district-command"}
    ).json()["token"]
    officer_headers = {"Authorization": f"Bearer {officer_token}"}

    before = client.get("/notifications?unread_only=true", headers=officer_headers).json()
    assert len(before) >= 2  # role_granted (posting created) + role_revoked (posting deleted)

    resp = client.post("/notifications/read-all", headers=officer_headers)
    assert resp.status_code == 204

    assert client.get("/notifications?unread_only=true", headers=officer_headers).json() == []
    all_notifications = client.get("/notifications", headers=officer_headers).json()
    assert len(all_notifications) >= 2
    assert all(n["read"] for n in all_notifications)


def test_clear_all_deletes_every_notification_for_that_officer_only(client):
    _seed()
    admin_headers = _super_admin_headers(client)
    officers = client.get("/admin/officers", headers=admin_headers).json()
    auditor = next(o for o in officers if o["badge_number"] == "GJ-AU-001")
    other = next(o for o in officers if o["badge_number"] == "GJ-SO-001")

    auditor_posting = client.post(
        "/admin/postings",
        json={"officer_id": auditor["id"], "role_name": "auditor", "scope_type": "platform", "scope_value": None},
        headers=admin_headers,
    ).json()
    other_posting = client.post(
        "/admin/postings",
        json={"officer_id": other["id"], "role_name": "station_officer", "scope_type": "district", "scope_value": "Home / Police"},
        headers=admin_headers,
    ).json()

    auditor_headers = {
        "Authorization": f"Bearer {client.post('/auth/login', json={'badge_number': 'GJ-AU-001', 'password': 'demo-pass-auditor'}).json()['token']}"
    }
    other_headers = {
        "Authorization": f"Bearer {client.post('/auth/login', json={'badge_number': 'GJ-SO-001', 'password': 'demo-pass-station-officer'}).json()['token']}"
    }

    assert len(client.get("/notifications", headers=auditor_headers).json()) >= 1
    assert len(client.get("/notifications", headers=other_headers).json()) >= 1

    resp = client.delete("/notifications", headers=auditor_headers)
    assert resp.status_code == 204
    assert client.get("/notifications", headers=auditor_headers).json() == []
    # Clearing the auditor's notifications must never touch the other officer's.
    assert len(client.get("/notifications", headers=other_headers).json()) >= 1

    client.delete(f"/admin/postings/{auditor_posting['id']}", headers=admin_headers)
    client.delete(f"/admin/postings/{other_posting['id']}", headers=admin_headers)


def test_revoking_a_posting_notifies_the_officer(client):
    _seed()
    admin_headers = _super_admin_headers(client)
    officers = client.get("/admin/officers", headers=admin_headers).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-CR-001")

    posting = client.post(
        "/admin/postings",
        json={"officer_id": target["id"], "role_name": "control_room_operator", "scope_type": "district", "scope_value": "Home / Police"},
        headers=admin_headers,
    ).json()
    client.delete(f"/admin/postings/{posting['id']}", headers=admin_headers)

    officer_token = client.post(
        "/auth/login", json={"badge_number": "GJ-CR-001", "password": "demo-pass-control-room"}
    ).json()["token"]
    notifications = client.get("/notifications", headers={"Authorization": f"Bearer {officer_token}"}).json()
    assert any(n["type"] == "role_revoked" for n in notifications)
