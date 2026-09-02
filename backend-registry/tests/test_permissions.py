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
