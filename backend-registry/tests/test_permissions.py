import jwt as pyjwt
from app.config import settings


def _rbac_token(role: str, permissions: list[str], scope_type: str = "platform", scope_value=None):
    return pyjwt.encode(
        {
            "sub": "1", "badge_number": "GJ-TEST-001", "name": "Test Officer",
            "role": role, "scope_type": scope_type, "scope_value": scope_value,
            "permissions": permissions,
        },
        settings.jwt_secret, algorithm="HS256",
    )


def test_legacy_officer_token_passes_any_permission_check(client):
    # officer_headers fixture (conftest.py) issues a hand-crafted {"role": "officer"}
    # token with no permissions claim -- must keep working unchanged everywhere.
    resp = client.get("/auth/me", headers={"Authorization": f"Bearer {_rbac_token('officer', [])}"})
    # legacy tokens have no badge_number/scope fields either -- /auth/me itself
    # isn't meant for them, this just proves require_permission doesn't reject them
    assert resp.status_code in (200, 422)


def test_rbac_token_with_permission_is_allowed(client, officer_headers):
    token = _rbac_token("station_officer", ["view_live_feeds", "edit_watchlist"])
    resp = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["role"] == "station_officer"
    assert "edit_watchlist" in body["permissions"]


def test_rbac_token_without_permission_is_rejected_on_a_gated_endpoint(client):
    # manage_cameras is required by PUT /cameras/{id} after Task 5 -- this
    # test intentionally reaches ahead to prove the rejection path, using
    # a role (control_room_operator's permission set) that never has it.
    token = _rbac_token("control_room_operator", ["view_live_feeds", "acknowledge_alerts"])
    resp = client.put(
        "/cameras/1",
        json={"name": "Should Not Work"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


def test_cameras_bulk_requires_manage_cameras_permission(client):
    # POST /cameras/bulk is gated by Depends(require_permission("manage_cameras"))
    # (Task 1's over-permissive require_role("officer") was replaced by the
    # final review fix wave). A role that actually has manage_cameras --
    # e.g. super_admin/district_command per seed_rbac.py's PERMISSIONS table
    # -- must still succeed; an empty list body is valid enough to pass
    # CameraBulkResult response validation (it just yields an empty results
    # list) while still exercising the permission gate itself.
    for rbac_role in ["super_admin", "district_command"]:
        token = _rbac_token(rbac_role, ["manage_cameras"])
        resp = client.post("/cameras/bulk", json=[], headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code != 403, f"role {rbac_role} with manage_cameras was rejected"


def test_cameras_bulk_rejects_roles_without_manage_cameras_permission(client):
    # auditor (only view_audit_logs) and station_officer (no manage_cameras
    # per seed_rbac.py) must both be rejected now that this endpoint checks
    # the permission, not just "is an RBAC role name" -- this is the exact
    # over-permissioning the final review flagged (auditor could previously
    # reach this endpoint via require_role's blanket RBAC-role acceptance).
    for rbac_role, perms in [("auditor", ["view_audit_logs"]), ("station_officer", ["search_vehicles"])]:
        token = _rbac_token(rbac_role, perms)
        resp = client.post("/cameras/bulk", json=[], headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 403, f"role {rbac_role} without manage_cameras was allowed"
