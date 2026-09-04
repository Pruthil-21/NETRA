import jwt
import pytest
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


@pytest.fixture
def audit_scope_test_data():
    """Two officers with active postings in two different (fabricated)
    districts, plus three audit_logs rows tagged with a resource_type unique
    to this fixture: one per officer, plus one attributed to "ml-anpr" (an
    actor with no matching officer/posting -- audit_logs_service.list_logs's
    scoping INNER JOIN drops actors like this by design). Cleans up
    everything it inserts in a finally block, even if an assertion raises,
    given this session's incident history with unsafe test cleanup on
    shared tables (officers/postings/audit_logs are all shared, non-test-only
    tables in this demo DB)."""
    resource_type = "audit_scope_test"
    district_a = "Audit Scope Test District A"
    district_b = "Audit Scope Test District B"
    badge_a = "AUDIT-SCOPE-A"
    badge_b = "AUDIT-SCOPE-B"

    officer_ids: list[int] = []
    posting_ids: list[int] = []
    log_ids: list[int] = []

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM roles WHERE name = %s", ("station_officer",))
            row = cur.fetchone()
            assert row is not None, "station_officer role not seeded -- run scripts/seed_rbac.py"
            role_id = row[0]

            for badge, district in [(badge_a, district_a), (badge_b, district_b)]:
                cur.execute(
                    """
                    INSERT INTO officers (badge_number, name, rank, password_hash)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (badge_number) DO UPDATE SET name = EXCLUDED.name
                    RETURNING id
                    """,
                    (badge, f"Audit Scope Test Officer ({district})", "Test Rank", "not-a-real-hash"),
                )
                officer_id = cur.fetchone()[0]
                officer_ids.append(officer_id)

                cur.execute(
                    "UPDATE postings SET is_active = false, ended_at = now() WHERE officer_id = %s AND is_active",
                    (officer_id,),
                )
                cur.execute(
                    """
                    INSERT INTO postings (officer_id, role_id, scope_type, scope_value, assigned_by)
                    VALUES (%s, %s, 'district', %s, 'test_audit_logs.py')
                    RETURNING id
                    """,
                    (officer_id, role_id, district),
                )
                posting_ids.append(cur.fetchone()[0])

            for badge in [badge_a, badge_b, "ml-anpr"]:
                cur.execute(
                    """
                    INSERT INTO audit_logs (badge_number, action, resource_type, resource_id)
                    VALUES (%s, 'create', %s, %s)
                    RETURNING id
                    """,
                    (badge, resource_type, 1),
                )
                log_ids.append(cur.fetchone()[0])
        conn.commit()

    try:
        yield {
            "resource_type": resource_type,
            "district_a": district_a,
            "district_b": district_b,
            "badge_a": badge_a,
            "badge_b": badge_b,
        }
    finally:
        with get_conn() as conn:
            with conn.cursor() as cur:
                if log_ids:
                    cur.execute("DELETE FROM audit_logs WHERE id = ANY(%s)", (log_ids,))
                if posting_ids:
                    cur.execute("DELETE FROM postings WHERE id = ANY(%s)", (posting_ids,))
                if officer_ids:
                    cur.execute("DELETE FROM officers WHERE id = ANY(%s)", (officer_ids,))
            conn.commit()


def test_district_command_scoped_to_own_district(client, audit_scope_test_data):
    data = audit_scope_test_data
    token = _make_rbac_token(
        "district_command", "district", data["district_a"], permissions=["view_audit_logs"]
    )
    resp = client.get(
        "/audit-logs",
        params={"resource_type": data["resource_type"]},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    badges = [entry["badge_number"] for entry in resp.json()["logs"]]
    assert data["badge_a"] in badges
    assert data["badge_b"] not in badges
    assert "ml-anpr" not in badges


def test_platform_scoped_role_sees_all_districts_and_actors_without_postings(client, audit_scope_test_data):
    data = audit_scope_test_data
    token = _make_rbac_token("super_admin", "platform", permissions=["view_audit_logs"])
    resp = client.get(
        "/audit-logs",
        params={"resource_type": data["resource_type"]},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    badges = [entry["badge_number"] for entry in resp.json()["logs"]]
    assert data["badge_a"] in badges
    assert data["badge_b"] in badges
    assert "ml-anpr" in badges


def test_audit_logs_limit_zero_returns_422(client):
    token = _make_rbac_token("super_admin", "platform", permissions=["view_audit_logs"])
    resp = client.get("/audit-logs", params={"limit": 0}, headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 422


def test_audit_logs_limit_negative_returns_422(client):
    token = _make_rbac_token("super_admin", "platform", permissions=["view_audit_logs"])
    resp = client.get("/audit-logs", params={"limit": -1}, headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 422
