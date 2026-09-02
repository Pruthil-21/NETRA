import subprocess
import sys

import jwt as pyjwt
from app.config import settings


def _token(role, permissions, scope_type="platform", scope_value=None, sub="998"):
    return pyjwt.encode(
        {"sub": sub, "badge_number": f"GJ-{role}", "role": role,
         "scope_type": scope_type, "scope_value": scope_value, "permissions": permissions},
        settings.jwt_secret, algorithm="HS256",
    )


def _super_admin_token(client):
    subprocess.run([sys.executable, "scripts/seed_rbac.py"], check=True, cwd="D:/NETRA/backend-registry")
    subprocess.run([sys.executable, "scripts/seed_demo_officers.py"], check=True, cwd="D:/NETRA/backend-registry")
    resp = client.post("/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"})
    return resp.json()["token"]


def test_super_admin_can_edit_a_roles_permissions(client):
    sa_token = _super_admin_token(client)

    resp = client.put(
        "/admin/roles/district_command/permissions",
        json={"permissions": ["view_live_feeds", "search_vehicles"], "reason_code": "SCOPE_REDUCTION"},
        headers={"Authorization": f"Bearer {sa_token}"},
    )
    assert resp.status_code == 200
    assert set(resp.json()["permissions"]) == {"view_live_feeds", "search_vehicles"}

    listed = client.get("/admin/roles", headers={"Authorization": f"Bearer {sa_token}"}).json()
    dc = next(r for r in listed if r["name"] == "district_command")
    assert "export_data" not in dc["permissions"]


def test_district_command_cannot_edit_role_permissions(client):
    # holds manage_users_roles (can reassign postings) but not manage_roles
    token = _token("district_command", ["view_live_feeds", "manage_users_roles"],
                    scope_type="district", scope_value="Traffic Police")
    resp = client.put(
        "/admin/roles/station_officer/permissions",
        json={"permissions": ["view_live_feeds"]},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


def test_unknown_permission_string_is_rejected(client):
    sa_token = _super_admin_token(client)
    resp = client.put(
        "/admin/roles/station_officer/permissions",
        json={"permissions": ["delete_everything"]},
        headers={"Authorization": f"Bearer {sa_token}"},
    )
    assert resp.status_code == 400


def test_cannot_remove_manage_roles_from_super_admin(client):
    # guards against an admin locking every Super Admin out of this
    # feature with no way back in short of a direct DB edit
    sa_token = _super_admin_token(client)
    resp = client.put(
        "/admin/roles/super_admin/permissions",
        json={"permissions": ["view_live_feeds"]},
        headers={"Authorization": f"Bearer {sa_token}"},
    )
    assert resp.status_code == 400
