import os
import subprocess
import sys

BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(script):
    subprocess.run([sys.executable, script], check=True, cwd=BACKEND_ROOT)


def _login(client, badge_number, password):
    resp = client.post("/auth/login", json={"badge_number": badge_number, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()["token"]


def _seed(client):
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")
    sa_token = _login(client, "GJ-SA-001", "demo-pass-super-admin")
    officers = client.get("/admin/officers", headers={"Authorization": f"Bearer {sa_token}"}).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")
    return sa_token, target


def test_super_admin_can_reset_another_officers_password(client):
    sa_token, target = _seed(client)

    resp = client.post(
        f"/admin/officers/{target['id']}/reset-password",
        json={"new_password": "brand-new-password-123"},
        headers={"Authorization": f"Bearer {sa_token}"},
    )
    assert resp.status_code == 204

    # Old password no longer works...
    old_login = client.post("/auth/login", json={"badge_number": "GJ-SO-001", "password": "demo-pass-station-officer"})
    assert old_login.status_code == 401

    # ...but the newly-set one does, with no need to know the old one.
    new_login = client.post("/auth/login", json={"badge_number": "GJ-SO-001", "password": "brand-new-password-123"})
    assert new_login.status_code == 200


def test_district_command_cannot_reset_passwords_despite_holding_manage_users_roles(client):
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")
    dc_token = _login(client, "GJ-DC-001", "demo-pass-district-command")

    sa_token = _login(client, "GJ-SA-001", "demo-pass-super-admin")
    officers = client.get("/admin/officers", headers={"Authorization": f"Bearer {sa_token}"}).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")

    resp = client.post(
        f"/admin/officers/{target['id']}/reset-password",
        json={"new_password": "should-not-be-allowed"},
        headers={"Authorization": f"Bearer {dc_token}"},
    )
    assert resp.status_code == 403


def test_reset_password_for_unknown_officer_404s(client):
    sa_token, _ = _seed(client)
    resp = client.post(
        "/admin/officers/999999/reset-password",
        json={"new_password": "whatever-123"},
        headers={"Authorization": f"Bearer {sa_token}"},
    )
    assert resp.status_code == 404
