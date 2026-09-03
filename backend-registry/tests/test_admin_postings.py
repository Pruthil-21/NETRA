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


def _token(role, permissions, scope_type="platform", scope_value=None, sub="999"):
    return pyjwt.encode(
        {"sub": sub, "badge_number": f"GJ-{role}", "role": role,
         "scope_type": scope_type, "scope_value": scope_value, "permissions": permissions},
        settings.jwt_secret, algorithm="HS256",
    )


def _seed(client):
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")
    resp = client.post("/auth/login", json={"badge_number": "GJ-DC-001", "password": "demo-pass-district-command"})
    return resp.json()["token"]


def test_super_admin_can_create_any_posting(client):
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")
    sa_token = client.post(
        "/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"}
    ).json()["token"]

    officers = client.get("/admin/officers", headers={"Authorization": f"Bearer {sa_token}"}).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")

    resp = client.post(
        "/admin/postings",
        json={"officer_id": target["id"], "role_name": "district_command", "scope_type": "district", "scope_value": "Home / Police"},
        headers={"Authorization": f"Bearer {sa_token}"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["role"] == "district_command"
    assert body["scope_value"] == "Home / Police"


def test_reassigning_a_posting_ends_the_old_one_not_edits_it(client):
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")
    sa_token = client.post(
        "/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"}
    ).json()["token"]

    officers = client.get("/admin/officers", headers={"Authorization": f"Bearer {sa_token}"}).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")
    original_posting_id = target["active_posting"]["id"]

    client.post(
        "/admin/postings",
        json={"officer_id": target["id"], "role_name": "station_officer", "scope_type": "district", "scope_value": "Home / Police"},
        headers={"Authorization": f"Bearer {sa_token}"},
    )

    postings = client.get("/admin/postings", headers={"Authorization": f"Bearer {sa_token}"}).json()
    old = next(p for p in postings if p["id"] == original_posting_id)
    assert old["is_active"] is False
    active_for_officer = [p for p in postings if p["officer_id"] == target["id"] and p["is_active"]]
    assert len(active_for_officer) == 1
    assert active_for_officer[0]["scope_value"] == "Home / Police"


def test_district_command_can_only_assign_within_their_own_district(client):
    dc_token = _seed(client)  # scope_value = "Traffic Police"

    sa_token = client.post(
        "/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"}
    ).json()["token"]
    officers = client.get("/admin/officers", headers={"Authorization": f"Bearer {sa_token}"}).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")  # currently "Traffic Police"

    # Allowed: reassigning within their own district
    ok = client.post(
        "/admin/postings",
        json={"officer_id": target["id"], "role_name": "station_officer", "scope_type": "district", "scope_value": "Traffic Police"},
        headers={"Authorization": f"Bearer {dc_token}"},
    )
    assert ok.status_code == 201

    # Blocked: assigning outside their own district
    blocked = client.post(
        "/admin/postings",
        json={"officer_id": target["id"], "role_name": "station_officer", "scope_type": "district", "scope_value": "Home / Police"},
        headers={"Authorization": f"Bearer {dc_token}"},
    )
    assert blocked.status_code == 403

    # Blocked: assigning a role they can't grant (district_command itself)
    blocked_role = client.post(
        "/admin/postings",
        json={"officer_id": target["id"], "role_name": "district_command", "scope_type": "district", "scope_value": "Traffic Police"},
        headers={"Authorization": f"Bearer {dc_token}"},
    )
    assert blocked_role.status_code == 403


def test_officer_without_manage_users_roles_permission_is_rejected(client):
    token = _token("control_room_operator", ["view_live_feeds", "acknowledge_alerts"])
    resp = client.get("/admin/officers", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403
