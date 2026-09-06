"""Self-registration + pending-approvals queue (v2 spec Section 3.2, Phase
B): the account is created with zero roles/postings, matching D365's "no
role, no privileges" rule -- the officer can log in but sees an empty
shell until approved."""
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


def _run(script):
    subprocess.run([sys.executable, script], check=True, cwd=BACKEND_ROOT)


def _seed():
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")


def _super_admin_headers(client):
    resp = client.post("/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"})
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def _register(client, badge=None):
    badge = badge or f"GJ-REG-{uuid.uuid4().hex[:8]}"
    resp = client.post(
        "/auth/register",
        json={"badge_number": badge, "name": "New Recruit", "rank": "Constable",
              "department": "Traffic", "contact_info": "recruit@example.com", "password": "recruit-pass-123"},
    )
    return badge, resp


def test_registration_creates_a_pending_officer_who_can_log_in_with_no_permissions(client):
    _seed()
    badge, resp = _register(client)
    assert resp.status_code == 201
    assert resp.json()["status"] == "pending"

    login_resp = client.post("/auth/login", json={"badge_number": badge, "password": "recruit-pass-123"})
    assert login_resp.status_code == 200
    token = login_resp.json()["token"]

    payload = pyjwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    assert payload["permissions"] == []
    assert payload["role"] is None

    me_resp = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me_resp.json()["status"] == "pending"


def test_registering_an_already_used_badge_number_is_rejected(client):
    _seed()
    resp = client.post(
        "/auth/register",
        json={"badge_number": "GJ-SA-001", "name": "Impersonator", "password": "whatever-1234"},
    )
    assert resp.status_code == 409


def test_approving_a_registration_assigns_the_initial_posting_and_activates_the_officer(client):
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

    login_resp = client.post("/auth/login", json={"badge_number": badge, "password": "recruit-pass-123"})
    payload = pyjwt.decode(login_resp.json()["token"], settings.jwt_secret, algorithms=["HS256"])
    assert payload["role"] == "station_officer"
    assert "view_live_feeds" in payload["permissions"]


def test_rejecting_a_registration_deactivates_the_account_and_it_cannot_log_in(client):
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


def test_district_command_can_approve_within_their_own_district(client):
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
