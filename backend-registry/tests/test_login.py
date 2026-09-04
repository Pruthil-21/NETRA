import os
import subprocess
import sys

import jwt as pyjwt
from app.config import settings

# backend-registry's root, computed relative to this file -- not a hardcoded
# path, so this works on any machine/OS, including CI (which has no D: drive).
BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(script):
    subprocess.run([sys.executable, script], check=True, cwd=BACKEND_ROOT)


def test_login_with_correct_password_returns_token_with_resolved_permissions(client):
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")

    resp = client.post("/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"})
    assert resp.status_code == 200
    body = resp.json()
    assert "token" in body

    payload = pyjwt.decode(body["token"], settings.jwt_secret, algorithms=["HS256"])
    assert payload["badge_number"] == "GJ-SA-001"
    assert payload["role"] == "super_admin"
    assert payload["scope_type"] == "platform"
    assert payload["scope_value"] is None
    assert "manage_users_roles" in payload["permissions"]
    assert "view_audit_logs" in payload["permissions"]


def test_login_with_wrong_password_returns_401(client):
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")

    resp = client.post("/auth/login", json={"badge_number": "GJ-SA-001", "password": "wrong-password"})
    assert resp.status_code == 401


def test_login_with_unknown_badge_number_returns_401(client):
    resp = client.post("/auth/login", json={"badge_number": "GJ-NOPE-999", "password": "anything"})
    assert resp.status_code == 401


def test_login_still_returns_401_for_both_wrong_password_and_unknown_badge_after_constant_time_fix(client):
    # Regression test for the constant-time login fix: verify_password() now
    # always runs (against a dummy hash when there's no matching officer),
    # so this just confirms the response is unchanged for both 401 paths.
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")

    wrong_password_resp = client.post(
        "/auth/login", json={"badge_number": "GJ-SA-001", "password": "wrong-password"}
    )
    assert wrong_password_resp.status_code == 401
    assert wrong_password_resp.json()["detail"] == "Invalid badge number or password"

    unknown_badge_resp = client.post(
        "/auth/login", json={"badge_number": "GJ-NOPE-999", "password": "anything"}
    )
    assert unknown_badge_resp.status_code == 401
    assert unknown_badge_resp.json()["detail"] == "Invalid badge number or password"


def test_district_command_token_carries_district_scope(client):
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")

    resp = client.post("/auth/login", json={"badge_number": "GJ-DC-001", "password": "demo-pass-district-command"})
    payload = pyjwt.decode(resp.json()["token"], settings.jwt_secret, algorithms=["HS256"])
    assert payload["role"] == "district_command"
    assert payload["scope_type"] == "district"
    assert payload["scope_value"] == "Traffic Police"
    assert "export_data" in payload["permissions"]
    assert "manage_cameras" in payload["permissions"]
