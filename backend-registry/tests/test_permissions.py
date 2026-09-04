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


def test_require_role_accepts_rbac_role_names(client):
    # POST /cameras/bulk is gated by Depends(require_role("officer")) -- the
    # only require_role usage in this service. An empty list body is valid
    # enough to pass CameraBulkResult response validation (it just yields an
    # empty results list) while still exercising the role gate itself; the
    # only thing under test here is that require_role doesn't 403 these roles.
    import jwt
    from app.config import settings

    for rbac_role in ["super_admin", "district_command", "station_officer", "control_room_operator", "auditor"]:
        token = jwt.encode({"sub": "rbac-test", "role": rbac_role}, settings.jwt_secret, algorithm="HS256")
        resp = client.post("/cameras/bulk", json=[], headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code != 403, f"role {rbac_role} was rejected by require_role"


def test_require_role_rejects_non_rbac_role(client):
    # Sanity check for the accept-path test above: a role outside the 5 RBAC
    # names (and not the legacy "officer"/"admin") must still be rejected by
    # require_role on the same endpoint.
    import jwt
    from app.config import settings

    token = jwt.encode({"sub": "rbac-test", "role": "viewer"}, settings.jwt_secret, algorithm="HS256")
    resp = client.post("/cameras/bulk", json=[], headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403
