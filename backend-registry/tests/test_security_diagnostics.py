"""Security diagnostics (v2 spec Section 3.5, Phase C): "why does/doesn't
this user have this access" -- resolves which role or duty is actually
granting (or would grant) a permission."""
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


def test_diagnostics_for_a_role_id_shows_direct_and_duty_granted_permissions(client):
    _seed()
    headers = _super_admin_headers(client)

    duty = client.post(
        "/admin/duties",
        json={"name": "diag_test_duty", "display_name": "Diag Test Duty", "permissions": ["view_analytics"]},
        headers=headers,
    ).json()
    role = client.post(
        "/admin/roles",
        json={"name": "diag_test_role", "display_name": "Diag Test Role", "duty_ids": [duty["id"]],
              "permissions": ["export_data"]},
        headers=headers,
    ).json()

    try:
        via_duty = client.get(
            f"/admin/diagnostics?role_id={role['id']}&permission=view_analytics", headers=headers
        ).json()
        assert via_duty["has_permission"] is True
        assert via_duty["granting_duties"] == {"diag_test_role": ["diag_test_duty"]}

        via_direct = client.get(
            f"/admin/diagnostics?role_id={role['id']}&permission=export_data", headers=headers
        ).json()
        assert via_direct["has_permission"] is True
        assert via_direct["granting_roles"] == ["diag_test_role"]

        missing = client.get(
            f"/admin/diagnostics?role_id={role['id']}&permission=manage_cameras", headers=headers
        ).json()
        assert missing["has_permission"] is False
        assert missing["granting_roles"] == []
        assert missing["granting_duties"] == {}
    finally:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM roles WHERE name = 'diag_test_role'")
                cur.execute("DELETE FROM duties WHERE name = 'diag_test_duty'")
            conn.commit()


def test_diagnostics_for_an_officer_resolves_via_their_active_posting(client):
    _seed()
    headers = _super_admin_headers(client)
    officers = client.get("/admin/officers", headers=headers).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")

    resp = client.get(
        f"/admin/diagnostics?officer_id={target['id']}&permission=view_live_feeds", headers=headers
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["has_permission"] is True
    assert "station_officer" in body["granting_roles"]


def test_diagnostics_requires_officer_id_or_role_id(client):
    _seed()
    headers = _super_admin_headers(client)
    resp = client.get("/admin/diagnostics?permission=view_live_feeds", headers=headers)
    assert resp.status_code == 400
