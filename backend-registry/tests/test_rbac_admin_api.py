"""API-level coverage for the v2 spec's dynamic role/duty management
endpoints (Section 5) -- Phase A. test_rbac_dynamic_roles.py already covers
the underlying rbac_service functions directly; this file covers the HTTP
layer (permission gating, request/response shapes, error codes)."""
import os
import subprocess
import sys

import jwt as pyjwt
import pytest
from app.config import settings
from app.db import get_conn

BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(script):
    subprocess.run([sys.executable, script], check=True, cwd=BACKEND_ROOT)


def _seed_and_login(client):
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")
    resp = client.post("/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"})
    return resp.json()["token"]


def _token(role, permissions, scope_type="platform", scope_value=None, sub="997"):
    return pyjwt.encode(
        {"sub": sub, "badge_number": f"GJ-{role}", "role": role,
         "scope_type": scope_type, "scope_value": scope_value, "permissions": permissions},
        settings.jwt_secret, algorithm="HS256",
    )


@pytest.fixture(autouse=True)
def _clean_test_roles_and_duties():
    yield
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM duties WHERE name LIKE 'test_%'")
            cur.execute(
                "DELETE FROM postings WHERE role_id IN (SELECT id FROM roles WHERE name LIKE 'test_%')"
            )
            cur.execute("DELETE FROM roles WHERE name LIKE 'test_%'")
        conn.commit()


def test_create_duty_then_compose_a_new_role_from_it(client):
    sa_token = _seed_and_login(client)
    headers = {"Authorization": f"Bearer {sa_token}"}

    duty_resp = client.post(
        "/admin/duties",
        json={"name": "test_watchlist_mgmt", "display_name": "Watchlist Management", "permissions": ["edit_watchlist", "view_analytics"]},
        headers=headers,
    )
    assert duty_resp.status_code == 201
    duty_id = duty_resp.json()["id"]

    role_resp = client.post(
        "/admin/roles",
        json={"name": "test_watchlist_role", "display_name": "Watchlist Role", "duty_ids": [duty_id]},
        headers=headers,
    )
    assert role_resp.status_code == 201
    role_id = role_resp.json()["id"]
    assert role_resp.json()["duty_ids"] == [duty_id]

    effective = client.get(f"/admin/roles/{role_id}/effective-permissions", headers=headers)
    assert set(effective.json()["permissions"]) == {"edit_watchlist", "view_analytics"}


def test_create_duty_rejects_unknown_permission_with_400(client):
    sa_token = _seed_and_login(client)
    resp = client.post(
        "/admin/duties",
        json={"name": "test_bad_duty", "display_name": "Bad Duty", "permissions": ["not_a_real_permission"]},
        headers={"Authorization": f"Bearer {sa_token}"},
    )
    assert resp.status_code == 400


def test_creating_a_duplicate_role_name_is_rejected_with_409(client):
    sa_token = _seed_and_login(client)
    resp = client.post(
        "/admin/roles",
        json={"name": "station_officer", "display_name": "Duplicate"},
        headers={"Authorization": f"Bearer {sa_token}"},
    )
    assert resp.status_code == 409


def test_clone_role_endpoint_copies_duties_independently(client):
    sa_token = _seed_and_login(client)
    headers = {"Authorization": f"Bearer {sa_token}"}
    duty_id = client.post(
        "/admin/duties",
        json={"name": "test_clone_duty", "display_name": "Clone Duty", "permissions": ["view_analytics"]},
        headers=headers,
    ).json()["id"]
    source = client.post(
        "/admin/roles",
        json={"name": "test_clone_source", "display_name": "Clone Source", "duty_ids": [duty_id]},
        headers=headers,
    ).json()

    clone_resp = client.post(
        f"/admin/roles/{source['id']}/clone",
        json={"name": "test_clone_target", "display_name": "Clone Target"},
        headers=headers,
    )
    assert clone_resp.status_code == 201
    clone = clone_resp.json()
    assert clone["duty_ids"] == [duty_id]

    client.put(f"/admin/roles/{clone['id']}/duties", json={"duty_ids": []}, headers=headers)

    source_effective = client.get(f"/admin/roles/{source['id']}/effective-permissions", headers=headers)
    assert set(source_effective.json()["permissions"]) == {"view_analytics"}


def test_deactivating_a_role_blocks_new_assignment_but_keeps_existing_holders(client):
    sa_token = _seed_and_login(client)
    headers = {"Authorization": f"Bearer {sa_token}"}

    role = client.post(
        "/admin/roles", json={"name": "test_deactivatable", "display_name": "Deactivatable"}, headers=headers,
    ).json()

    officers = client.get("/admin/officers", headers=headers).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-CR-001")
    posted = client.post(
        "/admin/postings",
        json={"officer_id": target["id"], "role_name": "test_deactivatable", "scope_type": "platform"},
        headers=headers,
    )
    assert posted.status_code == 201

    deactivated = client.post(f"/admin/roles/{role['id']}/deactivate", headers=headers)
    assert deactivated.status_code == 200
    assert deactivated.json()["is_active"] is False

    blocked = client.post(
        "/admin/postings",
        json={"officer_id": target["id"], "role_name": "test_deactivatable", "scope_type": "platform"},
        headers=headers,
    )
    assert blocked.status_code == 400

    still_active_postings = client.get("/admin/postings", headers=headers).json()
    assert any(p["id"] == posted.json()["id"] and p["is_active"] for p in still_active_postings)


def test_deleting_a_system_seeded_role_is_rejected(client):
    sa_token = _seed_and_login(client)
    headers = {"Authorization": f"Bearer {sa_token}"}
    role = client.get("/admin/roles", headers=headers).json()
    auditor_id_resp = client.post(
        "/admin/roles", json={"name": "test_role_for_delete_check", "display_name": "X"}, headers=headers,
    ).json()
    # Deleting a brand-new, unheld, non-system role succeeds...
    delete_resp = client.delete(f"/admin/roles/{auditor_id_resp['id']}", headers=headers)
    assert delete_resp.status_code == 204

    # ...but the originally-seeded roles never can, even with no current holders.
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM roles WHERE name = 'auditor'")
            auditor_role_id = cur.fetchone()[0]
    blocked = client.delete(f"/admin/roles/{auditor_role_id}", headers=headers)
    assert blocked.status_code == 400


def test_district_command_without_manage_roles_cannot_create_a_role(client):
    _seed_and_login(client)
    token = _token("district_command", ["manage_users_roles"], scope_type="district", scope_value="Ahmedabad")
    resp = client.post(
        "/admin/roles",
        json={"name": "test_forbidden_role", "display_name": "Forbidden"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403
