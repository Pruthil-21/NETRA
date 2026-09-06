"""Account lockout policy (v2 spec Section 3.6, Phase B): N consecutive
failed logins locks the account for a cooldown, with an admin override to
unlock early."""
import os
import subprocess
import sys

from app.db import get_conn
from app.services import auth_service

BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(script):
    subprocess.run([sys.executable, script], check=True, cwd=BACKEND_ROOT)


def _seed():
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")


def _super_admin_headers(client):
    resp = client.post("/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"})
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def test_repeated_wrong_passwords_lock_the_account(client):
    _seed()
    for _ in range(auth_service.MAX_FAILED_LOGIN_ATTEMPTS):
        resp = client.post("/auth/login", json={"badge_number": "GJ-SO-001", "password": "wrong-password"})
        assert resp.status_code == 401

    locked_resp = client.post(
        "/auth/login", json={"badge_number": "GJ-SO-001", "password": "demo-pass-station-officer"}
    )
    assert locked_resp.status_code == 423


def test_admin_can_unlock_an_account_before_the_cooldown_expires(client):
    _seed()
    headers = _super_admin_headers(client)
    officers = client.get("/admin/officers", headers=headers).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")

    for _ in range(auth_service.MAX_FAILED_LOGIN_ATTEMPTS):
        client.post("/auth/login", json={"badge_number": "GJ-SO-001", "password": "wrong-password"})

    unlock_resp = client.post(f"/admin/officers/{target['id']}/unlock", headers=headers)
    assert unlock_resp.status_code == 204

    ok_resp = client.post(
        "/auth/login", json={"badge_number": "GJ-SO-001", "password": "demo-pass-station-officer"}
    )
    assert ok_resp.status_code == 200


def test_a_successful_login_resets_the_failed_attempt_counter():
    _seed()
    with get_conn() as conn:
        officer = auth_service.get_officer_by_badge(conn, "GJ-SO-001")
        auth_service.record_failed_login(conn, officer["id"])
        auth_service.record_failed_login(conn, officer["id"])
        auth_service.record_successful_login(conn, officer["id"])
        refreshed = auth_service.get_officer_by_badge(conn, "GJ-SO-001")
    assert refreshed["failed_login_count"] == 0
    assert refreshed["locked_until"] is None
    assert refreshed["last_login_at"] is not None
