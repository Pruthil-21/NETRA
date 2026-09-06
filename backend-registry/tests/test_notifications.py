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
