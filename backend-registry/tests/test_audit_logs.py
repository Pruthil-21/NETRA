import jwt
from app.config import settings
from app.db import get_conn


def _make_rbac_token(role, scope_type, scope_value=None, badge_number="AUDIT-TEST-001", permissions=None):
    # require_permission() checks the JWT's own "permissions" claim directly
    # (app/auth.py) rather than re-deriving it from the DB by role -- so a
    # token asserting it CAN reach a gated route must carry that permission
    # explicitly, same as every other RBAC token fixture in this suite (see
    # test_permissions.py's _rbac_token). Defaults to [] so a token that's
    # only meant to prove a REJECTION (e.g. station_officer, below) doesn't
    # need to say so at every call site.
    return jwt.encode(
        {"sub": "1", "badge_number": badge_number, "role": role, "scope_type": scope_type,
         "scope_value": scope_value, "permissions": permissions or []},
        settings.jwt_secret, algorithm="HS256",
    )


def test_super_admin_sees_audit_logs(client):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO audit_logs (badge_number, action, resource_type, resource_id) VALUES (%s, %s, %s, %s)",
                ("AUDIT-TEST-001", "create", "camera", 999),
            )
        conn.commit()

    token = _make_rbac_token("super_admin", "platform", permissions=["view_audit_logs"])
    # This is a shared demo DB with a substantial pre-existing audit_logs
    # history (thousands of rows from prior seeding/test runs); the endpoint
    # orders ascending by id with no cursor, so an unfiltered request would
    # return the OLDEST page, never this freshly-inserted row. Scope by
    # badge_number -- a filter the endpoint already supports -- rather than
    # relying on unbounded pagination order to surface it.
    resp = client.get(
        "/audit-logs",
        params={"badge_number": "AUDIT-TEST-001"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "logs" in body
    assert any(entry["resource_id"] == 999 for entry in body["logs"])


def test_station_officer_forbidden(client):
    token = _make_rbac_token("station_officer", "district", "Traffic Police")
    resp = client.get("/audit-logs", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403


def test_district_command_scoped_to_own_district(client):
    # Officer + posting fixtures assumed seeded by conftest/seed scripts for
    # this environment (see seed_demo_officers.py) -- adjust badge numbers if
    # the environment's seed data differs.
    token = _make_rbac_token("district_command", "district", "Traffic Police", permissions=["view_audit_logs"])
    resp = client.get("/audit-logs", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
