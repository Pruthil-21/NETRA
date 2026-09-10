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


def test_creating_a_new_posting_does_not_end_existing_active_postings(client):
    """Multi-role support (spec Section 3.3): an officer can hold several
    simultaneously-active postings. POST /admin/postings only ever adds --
    ending a specific one is a separate, explicit action (DELETE
    /admin/postings/{id}, see below)."""
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")
    sa_token = client.post(
        "/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"}
    ).json()["token"]

    officers = client.get("/admin/officers", headers={"Authorization": f"Bearer {sa_token}"}).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")
    original_posting_id = target["active_posting"]["id"]

    resp = client.post(
        "/admin/postings",
        json={"officer_id": target["id"], "role_name": "station_officer", "scope_type": "district", "scope_value": "Home / Police"},
        headers={"Authorization": f"Bearer {sa_token}"},
    )
    assert resp.status_code == 201
    new_posting_id = resp.json()["id"]

    postings = client.get("/admin/postings", headers={"Authorization": f"Bearer {sa_token}"}).json()
    old = next(p for p in postings if p["id"] == original_posting_id)
    new = next(p for p in postings if p["id"] == new_posting_id)
    assert old["is_active"] is True
    assert new["is_active"] is True
    active_for_officer = [p for p in postings if p["officer_id"] == target["id"] and p["is_active"]]
    assert len(active_for_officer) == 2

    officers_after = client.get("/admin/officers", headers={"Authorization": f"Bearer {sa_token}"}).json()
    target_after = next(o for o in officers_after if o["id"] == target["id"])
    assert len(target_after["active_postings"]) == 2


def test_revoking_one_posting_leaves_the_officers_other_postings_active(client):
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")
    sa_token = client.post(
        "/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"}
    ).json()["token"]

    officers = client.get("/admin/officers", headers={"Authorization": f"Bearer {sa_token}"}).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")
    original_posting_id = target["active_posting"]["id"]

    second = client.post(
        "/admin/postings",
        json={"officer_id": target["id"], "role_name": "station_officer", "scope_type": "district", "scope_value": "Home / Police"},
        headers={"Authorization": f"Bearer {sa_token}"},
    ).json()

    resp = client.delete(f"/admin/postings/{original_posting_id}", headers={"Authorization": f"Bearer {sa_token}"})
    assert resp.status_code == 204

    postings = client.get("/admin/postings", headers={"Authorization": f"Bearer {sa_token}"}).json()
    old = next(p for p in postings if p["id"] == original_posting_id)
    still_active = next(p for p in postings if p["id"] == second["id"])
    assert old["is_active"] is False
    assert still_active["is_active"] is True


def test_revoking_an_already_inactive_posting_returns_404(client):
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")
    sa_token = client.post(
        "/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"}
    ).json()["token"]
    resp = client.delete("/admin/postings/999999", headers={"Authorization": f"Bearer {sa_token}"})
    assert resp.status_code == 404


def test_district_command_can_only_assign_within_their_own_district(client):
    dc_token = _seed(client)  # scope_value = "Ahmedabad"

    sa_token = client.post(
        "/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"}
    ).json()["token"]
    officers = client.get("/admin/officers", headers={"Authorization": f"Bearer {sa_token}"}).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")  # currently "Ahmedabad"

    # Allowed: reassigning within their own district
    ok = client.post(
        "/admin/postings",
        json={"officer_id": target["id"], "role_name": "station_officer", "scope_type": "district", "scope_value": "Ahmedabad"},
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
        json={"officer_id": target["id"], "role_name": "district_command", "scope_type": "district", "scope_value": "Ahmedabad"},
        headers={"Authorization": f"Bearer {dc_token}"},
    )
    assert blocked_role.status_code == 403


def test_officer_without_manage_users_roles_permission_is_rejected(client):
    token = _token("control_room_operator", ["view_live_feeds", "acknowledge_alerts"])
    resp = client.get("/admin/officers", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403
