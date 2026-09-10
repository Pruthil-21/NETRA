"""Suspend/reactivate, force-logout, and the full admin-facing officer
profile (v2 spec Sections 3.4/3.5/3.6, Phase B)."""
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


def test_suspending_an_officer_blocks_login_and_reactivating_restores_it(client):
    _seed()
    admin_headers = _super_admin_headers(client)
    officers = client.get("/admin/officers", headers=admin_headers).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")

    suspend_resp = client.post(f"/admin/officers/{target['id']}/suspend", headers=admin_headers)
    assert suspend_resp.status_code == 204

    blocked_login = client.post(
        "/auth/login", json={"badge_number": "GJ-SO-001", "password": "demo-pass-station-officer"}
    )
    assert blocked_login.status_code == 403

    reactivate_resp = client.post(f"/admin/officers/{target['id']}/reactivate", headers=admin_headers)
    assert reactivate_resp.status_code == 204

    ok_login = client.post(
        "/auth/login", json={"badge_number": "GJ-SO-001", "password": "demo-pass-station-officer"}
    )
    assert ok_login.status_code == 200


def test_force_logout_revokes_an_officers_active_session_token(client):
    _seed()
    admin_headers = _super_admin_headers(client)

    login_resp = client.post(
        "/auth/login", json={"badge_number": "GJ-SO-001", "password": "demo-pass-station-officer"}
    )
    officer_token = login_resp.json()["token"]
    officer_headers = {"Authorization": f"Bearer {officer_token}"}

    # The session is valid before force-logout.
    assert client.get("/auth/me", headers=officer_headers).status_code == 200

    officers = client.get("/admin/officers", headers=admin_headers).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")
    resp = client.post(f"/admin/officers/{target['id']}/force-logout", headers=admin_headers)
    assert resp.status_code == 204

    revoked_resp = client.get("/auth/me", headers=officer_headers)
    assert revoked_resp.status_code == 401


def test_force_logout_does_not_affect_a_freshly_issued_token(client):
    """Revoking the *old* session must not somehow break a brand-new login
    -- each login issues its own session id."""
    _seed()
    admin_headers = _super_admin_headers(client)

    old_token = client.post(
        "/auth/login", json={"badge_number": "GJ-SO-001", "password": "demo-pass-station-officer"}
    ).json()["token"]

    officers = client.get("/admin/officers", headers=admin_headers).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")
    client.post(f"/admin/officers/{target['id']}/force-logout", headers=admin_headers)

    new_token = client.post(
        "/auth/login", json={"badge_number": "GJ-SO-001", "password": "demo-pass-station-officer"}
    ).json()["token"]

    assert client.get("/auth/me", headers={"Authorization": f"Bearer {old_token}"}).status_code == 401
    assert client.get("/auth/me", headers={"Authorization": f"Bearer {new_token}"}).status_code == 200


def test_full_officer_profile_lists_every_active_posting_and_recent_logins(client):
    _seed()
    admin_headers = _super_admin_headers(client)
    officers = client.get("/admin/officers", headers=admin_headers).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")

    client.post(
        "/admin/postings",
        json={"officer_id": target["id"], "role_name": "station_officer", "scope_type": "district", "scope_value": "Home / Police"},
        headers=admin_headers,
    )
    client.post("/auth/login", json={"badge_number": "GJ-SO-001", "password": "demo-pass-station-officer"})

    profile = client.get(f"/admin/officers/{target['id']}", headers=admin_headers)
    assert profile.status_code == 200
    body = profile.json()
    assert body["status"] == "active"
    assert len(body["active_postings"]) == 2
    assert len(body["recent_logins"]) >= 1
