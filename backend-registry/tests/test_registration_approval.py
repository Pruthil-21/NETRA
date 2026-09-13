"""Self-registration (v2 spec Section 3.2, updated): the officer row is
created immediately with zero postings, matching D365's "no role, no
privileges" rule -- but activation no longer waits on a human. Verifying
the OTP emailed at registration both proves the registrant controls that
inbox and activates the account with a baseline posting (station_officer,
scoped to the district they gave) in one step, logging them straight in.

Manual admin approve/reject (POST /admin/approvals/{id}/...) still exist as
a fast-track/override an admin can use before the registrant ever checks
their email -- covered here alongside the new default path."""
import os
import subprocess
import sys
import uuid

import jwt as pyjwt
import pytest
from app.config import settings
from app.db import get_conn

BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(autouse=True)
def _clean_registered_test_officers():
    yield
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM officers WHERE badge_number LIKE 'GJ-REG-%'")
        conn.commit()


# captured_otps (autouse) comes from conftest.py -- requested by name below
# wherever a test needs to read the actual code back out.


def _run(script):
    subprocess.run([sys.executable, script], check=True, cwd=BACKEND_ROOT)


def _seed():
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")


def _super_admin_headers(client):
    resp = client.post("/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"})
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def _register(client, badge=None, department="Ahmedabad"):
    badge = badge or f"GJ-REG-{uuid.uuid4().hex[:8]}"
    resp = client.post(
        "/auth/register",
        json={
            "badge_number": badge, "name": "New Recruit", "rank": "Constable", "department": department,
            "email": f"{badge.lower()}@example.com", "contact_info": "recruit@example.com",
            "password": "recruit-pass-123",
        },
    )
    return badge, resp


def test_registration_returns_a_pending_token_not_an_active_account(client, captured_otps):
    _seed()
    badge, resp = _register(client)
    assert resp.status_code == 201
    assert "pending_token" in resp.json()
    assert len(captured_otps) == 1
    assert captured_otps[0][2] == "email_verification"

    # Not yet active -- can't do anything until verified.
    login_resp = client.post("/auth/login", json={"badge_number": badge, "password": "recruit-pass-123"})
    assert login_resp.status_code == 200
    assert login_resp.json()["otp_required"] is True  # email is set immediately, gates login same as any 2FA account


def test_verifying_the_registration_otp_activates_and_logs_in(client, captured_otps):
    _seed()
    _badge, resp = _register(client, department="Anand")
    pending_token = resp.json()["pending_token"]
    code = captured_otps[0][1]

    verify_resp = client.post("/auth/register/verify", json={"pending_token": pending_token, "code": code})
    assert verify_resp.status_code == 200
    token = verify_resp.json()["token"]

    payload = pyjwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    assert payload["role"] == "station_officer"
    assert payload["scope_type"] == "district"
    assert payload["scope_value"] == "Anand"
    assert "view_live_feeds" in payload["permissions"]

    me_resp = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me_resp.json()["status"] == "active"


def test_verifying_with_the_wrong_code_does_not_activate(client, captured_otps):
    _seed()
    badge, resp = _register(client)
    pending_token = resp.json()["pending_token"]

    verify_resp = client.post("/auth/register/verify", json={"pending_token": pending_token, "code": "000000"})
    assert verify_resp.status_code == 401

    me_status = client.post("/auth/login", json={"badge_number": badge, "password": "recruit-pass-123"})
    # Still pending -- an unverified officer's own login still needs its own
    # OTP (their email is on file from registration), but the account was
    # never activated/given a posting either way.
    assert me_status.status_code == 200


def test_registering_an_already_used_badge_number_is_rejected(client, captured_otps):
    _seed()
    resp = client.post(
        "/auth/register",
        json={
            "badge_number": "GJ-SA-001", "name": "Impersonator", "department": "Ahmedabad",
            "email": "impersonator@example.com", "contact_info": "9876543210", "password": "whatever-1234",
        },
    )
    assert resp.status_code == 409


def test_registering_without_a_department_is_rejected(client, captured_otps):
    _seed()
    resp = client.post(
        "/auth/register",
        json={
            "badge_number": f"GJ-REG-{uuid.uuid4().hex[:8]}", "name": "No District", "department": "",
            "email": "nodistrict@example.com", "password": "whatever-1234",
        },
    )
    assert resp.status_code == 422


def test_registering_with_an_invalid_email_is_rejected(client, captured_otps):
    _seed()
    resp = client.post(
        "/auth/register",
        json={
            "badge_number": f"GJ-REG-{uuid.uuid4().hex[:8]}", "name": "Bad Email", "department": "Ahmedabad",
            "email": "not-an-email", "password": "whatever-1234",
        },
    )
    assert resp.status_code == 422


def test_registering_with_a_district_that_does_not_exist_is_rejected(client, captured_otps):
    _seed()
    resp = client.post(
        "/auth/register",
        json={
            "badge_number": f"GJ-REG-{uuid.uuid4().hex[:8]}", "name": "Nowhere District",
            "department": "Not A Real District", "email": "nowhere@example.com",
            "contact_info": "9876543210", "password": "whatever-1234",
        },
    )
    assert resp.status_code == 400
    assert "valid Gujarat district" in resp.json()["detail"]


def test_registering_with_a_weak_password_is_rejected(client, captured_otps):
    _seed()
    resp = client.post(
        "/auth/register",
        json={
            "badge_number": f"GJ-REG-{uuid.uuid4().hex[:8]}", "name": "Weak Password",
            "department": "Ahmedabad", "email": "weakpass@example.com",
            "contact_info": "9876543210", "password": "password",
        },
    )
    assert resp.status_code == 400
    assert "too weak" in resp.json()["detail"].lower()


def test_admin_can_still_approve_a_registration_before_it_is_email_verified(client, captured_otps):
    # Manual approve/reject remain available as a fast-track/override --
    # an admin doesn't have to wait for the registrant to check their email.
    _seed()
    admin_headers = _super_admin_headers(client)
    badge, _ = _register(client)

    approvals = client.get("/admin/approvals?status=pending", headers=admin_headers).json()
    request = next(r for r in approvals if r["badge_number"] == badge)

    approve_resp = client.post(
        f"/admin/approvals/{request['id']}/approve",
        json={"role_name": "station_officer", "scope_type": "district", "scope_value": "Ahmedabad"},
        headers=admin_headers,
    )
    assert approve_resp.status_code == 200
    assert approve_resp.json()["status"] == "approved"


def test_rejecting_a_registration_deactivates_the_account_and_it_cannot_log_in(client, captured_otps):
    _seed()
    admin_headers = _super_admin_headers(client)
    badge, _ = _register(client)

    approvals = client.get("/admin/approvals?status=pending", headers=admin_headers).json()
    request = next(r for r in approvals if r["badge_number"] == badge)

    reject_resp = client.post(
        f"/admin/approvals/{request['id']}/reject", json={"reason": "Badge could not be verified"},
        headers=admin_headers,
    )
    assert reject_resp.status_code == 200
    assert reject_resp.json()["status"] == "rejected"
    assert reject_resp.json()["rejection_reason"] == "Badge could not be verified"

    login_resp = client.post("/auth/login", json={"badge_number": badge, "password": "recruit-pass-123"})
    assert login_resp.status_code == 403


def test_district_command_can_approve_within_their_own_district(client, captured_otps):
    _seed()
    dc_token = client.post(
        "/auth/login", json={"badge_number": "GJ-DC-001", "password": "demo-pass-district-command"}
    ).json()["token"]
    badge, _ = _register(client)

    approvals = client.get(
        "/admin/approvals?status=pending", headers={"Authorization": f"Bearer {dc_token}"}
    ).json()
    request = next(r for r in approvals if r["badge_number"] == badge)

    resp = client.post(
        f"/admin/approvals/{request['id']}/approve",
        json={"role_name": "station_officer", "scope_type": "district", "scope_value": "Ahmedabad"},
        headers={"Authorization": f"Bearer {dc_token}"},
    )
    assert resp.status_code == 200
