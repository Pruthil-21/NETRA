"""Draft/Publish for role edits (v2 spec Sections 2.4/3.1, Phase D): a
staged change to a role's composition that doesn't take effect until
explicitly published, with an "effective permissions diff" reviewable
first."""
import os
import subprocess
import sys

from app.db import get_conn

BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(script):
    subprocess.run([sys.executable, script], check=True, cwd=BACKEND_ROOT)


def _seed():
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")


def _super_admin_headers(client):
    resp = client.post("/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"})
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def test_saving_a_draft_does_not_change_the_roles_live_effective_permissions(client):
    _seed()
    headers = _super_admin_headers(client)
    role = client.post(
        "/admin/roles", json={"name": "draft_test_role", "display_name": "Draft Role", "permissions": ["view_live_feeds"]},
        headers=headers,
    ).json()

    try:
        draft_resp = client.put(
            f"/admin/roles/{role['id']}/draft",
            json={"duty_ids": [], "permissions": ["view_live_feeds", "manage_cameras"]},
            headers=headers,
        )
        assert draft_resp.status_code == 200

        still_live = client.get(f"/admin/roles/{role['id']}/effective-permissions", headers=headers).json()
        assert set(still_live["permissions"]) == {"view_live_feeds"}

        diff = client.get(f"/admin/roles/{role['id']}/diff", headers=headers).json()
        assert diff["has_draft"] is True
        assert diff["added_permissions"] == ["manage_cameras"]
        assert diff["removed_permissions"] == []
        assert diff["affected_active_holders"] == 0
    finally:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM roles WHERE name = 'draft_test_role'")
            conn.commit()


def test_publishing_a_draft_applies_it_and_clears_the_draft(client):
    _seed()
    headers = _super_admin_headers(client)
    role = client.post(
        "/admin/roles", json={"name": "publish_test_role", "display_name": "Publish Role", "permissions": ["view_live_feeds"]},
        headers=headers,
    ).json()

    try:
        client.put(
            f"/admin/roles/{role['id']}/draft",
            json={"duty_ids": [], "permissions": ["export_data"]},
            headers=headers,
        )
        publish_resp = client.post(f"/admin/roles/{role['id']}/publish", headers=headers)
        assert publish_resp.status_code == 200

        effective = client.get(f"/admin/roles/{role['id']}/effective-permissions", headers=headers).json()
        assert set(effective["permissions"]) == {"export_data"}

        diff_after = client.get(f"/admin/roles/{role['id']}/diff", headers=headers).json()
        assert diff_after["has_draft"] is False
    finally:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM roles WHERE name = 'publish_test_role'")
            conn.commit()


def test_publishing_with_no_pending_draft_is_rejected(client):
    _seed()
    headers = _super_admin_headers(client)
    role = client.post("/admin/roles", json={"name": "no_draft_role", "display_name": "No Draft"}, headers=headers).json()
    try:
        resp = client.post(f"/admin/roles/{role['id']}/publish", headers=headers)
        assert resp.status_code == 400
    finally:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM roles WHERE name = 'no_draft_role'")
            conn.commit()
