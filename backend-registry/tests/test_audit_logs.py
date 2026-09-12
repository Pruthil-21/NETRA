import jwt
import pytest
from app.config import settings
from app.db import get_conn
from app.services.audit_logs_service import categorize


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
    # history (thousands of rows from prior seeding/test runs). The endpoint
    # orders newest-first, so this freshly-inserted row would actually be on
    # the first unfiltered page too -- scoping by badge_number here anyway
    # (a filter the endpoint already supports) so this test stays correct
    # even if a concurrent test run's row landed at the exact same moment.
    resp = client.get(
        "/audit-logs",
        params={"badge_number": "AUDIT-TEST-001"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "logs" in body
    assert any(entry["resource_id"] == 999 for entry in body["logs"])


def test_logs_are_newest_first_and_load_more_walks_backward_in_time(client):
    """A real audit log an officer actually looks at needs to open on
    what just happened, not the oldest row in a years-old, thousands-of-rows
    history -- see the camera-uptime feature this DB now accumulates dozens
    of rows a day for. Three fresh rows, oldest to newest, must come back
    newest-first, and cursor pagination must walk further BACK in time
    (smaller ids), not skip past them into the future."""
    badge = "AUDIT-ORDER-TEST"
    with get_conn() as conn:
        with conn.cursor() as cur:
            ids = []
            for i in range(3):
                cur.execute(
                    "INSERT INTO audit_logs (badge_number, action, resource_type, resource_id) "
                    "VALUES (%s, %s, %s, %s) RETURNING id",
                    (badge, "create", "camera", 9000 + i),
                )
                ids.append(cur.fetchone()[0])
        conn.commit()

    token = _make_rbac_token("super_admin", "platform", permissions=["view_audit_logs"])
    try:
        resp = client.get(
            "/audit-logs",
            params={"badge_number": badge, "limit": 2},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        body = resp.json()
        # Newest-first: the row inserted LAST (highest id) appears FIRST.
        assert [entry["resource_id"] for entry in body["logs"]] == [9002, 9001]
        assert body["next_cursor"] is not None

        page2 = client.get(
            "/audit-logs",
            params={"badge_number": badge, "limit": 2, "cursor": body["next_cursor"]},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert [entry["resource_id"] for entry in page2.json()["logs"]] == [9000]
    finally:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM audit_logs WHERE id = ANY(%s)", (ids,))
            conn.commit()


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


@pytest.fixture
def category_test_data():
    """One real camera (so camera_id/camera_district/camera_area_id filters
    have something genuine to resolve against) plus one audit_logs row per
    category-defining action/resource_type, tagged with a badge_number
    unique to this fixture so assertions never depend on the shared demo
    DB's pre-existing history. Cleans up everything it inserts."""
    badge = "AUDIT-CATEGORY-TEST"
    camera_id = None
    log_ids: list[int] = []

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days)
                VALUES ('Audit Category Test Cam', 'Audit Category Test District',
                        ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'Bullet', 'Test Rig', 'Cloud', 30)
                RETURNING id
                """,
            )
            camera_id = cur.fetchone()[0]

            rows = [
                (badge, "login", "officer", None),
                (badge, "change_password", "officer", None),
                (badge, "reassign_posting", "posting", None),
                (badge, "create", "camera", camera_id),
                (badge, "create", "area", None),
                (badge, "status_change", "alert", None),
                (badge, "create", "detection", None),
            ]
            for b, action, resource_type, resource_id in rows:
                cur.execute(
                    """
                    INSERT INTO audit_logs (badge_number, action, resource_type, resource_id)
                    VALUES (%s, %s, %s, %s)
                    RETURNING id
                    """,
                    (b, action, resource_type, resource_id),
                )
                log_ids.append(cur.fetchone()[0])
        conn.commit()

    try:
        yield {"badge": badge, "camera_id": camera_id}
    finally:
        with get_conn() as conn:
            with conn.cursor() as cur:
                if log_ids:
                    cur.execute("DELETE FROM audit_logs WHERE id = ANY(%s)", (log_ids,))
                if camera_id:
                    cur.execute("DELETE FROM cameras WHERE id = %s", (camera_id,))
            conn.commit()


@pytest.mark.parametrize(
    "category,expected_action",
    [
        ("authentication", "login"),
        ("credentials", "change_password"),
        ("user_management", "reassign_posting"),
        ("camera_registry", "create"),
        ("infrastructure", "create"),
        ("alerts", "status_change"),
        ("detections", "create"),
    ],
)
def test_category_filter_returns_only_that_categorys_entries(client, category_test_data, category, expected_action):
    data = category_test_data
    token = _make_rbac_token("super_admin", "platform", permissions=["view_audit_logs"])
    resp = client.get(
        "/audit-logs",
        params={"badge_number": data["badge"], "category": category},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    logs = resp.json()["logs"]
    assert len(logs) == 1
    assert logs[0]["category"] == category
    assert logs[0]["action"] == expected_action


def test_camera_id_filter_resolves_camera_name_and_location(client, category_test_data):
    data = category_test_data
    token = _make_rbac_token("super_admin", "platform", permissions=["view_audit_logs"])
    resp = client.get(
        "/audit-logs",
        params={"badge_number": data["badge"], "camera_id": data["camera_id"]},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    logs = resp.json()["logs"]
    assert len(logs) == 1
    assert logs[0]["camera_name"] == "Audit Category Test Cam"
    assert logs[0]["camera_district"] == "Audit Category Test District"


def test_camera_district_filter(client, category_test_data):
    data = category_test_data
    token = _make_rbac_token("super_admin", "platform", permissions=["view_audit_logs"])
    resp = client.get(
        "/audit-logs",
        params={"badge_number": data["badge"], "camera_district": "Audit Category Test District"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    logs = resp.json()["logs"]
    assert len(logs) == 1
    assert logs[0]["resource_type"] == "camera"

    # A district that doesn't match any camera excludes everything, even
    # though this badge has other (non-camera) entries too.
    miss = client.get(
        "/audit-logs",
        params={"badge_number": data["badge"], "camera_district": "Nowhere District"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert miss.json()["logs"] == []


def test_categories_endpoint_lists_every_category_plus_other(client):
    token = _make_rbac_token("super_admin", "platform", permissions=["view_audit_logs"])
    resp = client.get("/audit-logs/categories", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    categories = resp.json()["categories"]
    for expected in [
        "authentication", "credentials", "user_management", "camera_registry",
        "infrastructure", "alerts", "detections", "other",
    ]:
        assert expected in categories


@pytest.mark.parametrize(
    "action,resource_type,expected_category",
    [
        # Legacy rows from before the Circle -> Area rename, and from a
        # separation-of-duties feature -- no live route creates either
        # anymore, but real historical audit_logs rows still carry them, and
        # they used to fall into "other" with no real category at all.
        ("create", "circle", "infrastructure"),
        ("update", "circle", "infrastructure"),
        ("delete", "circle", "infrastructure"),
        ("create_sod_rule", "sod_rule", "user_management"),
        ("delete_sod_rule", "sod_rule", "user_management"),
        ("sod_conflict_blocked", "officer", "user_management"),
    ],
)
def test_legacy_resource_types_are_categorized_not_left_as_other(action, resource_type, expected_category):
    assert categorize(action, resource_type) == expected_category


def test_user_management_category_excludes_rows_an_earlier_category_already_claims(client, category_test_data):
    """resource_type="officer" sits in user_management's resource_types
    (officer lifecycle actions), but login/change_password rows -- also
    resource_type="officer" -- belong to authentication/credentials, whose
    ACTION-based rules are checked first by categorize(). Filtering by
    category="user_management" must agree with that and exclude them, or
    the SQL filter and the label shown on an already-fetched row would
    disagree on the very same row."""
    data = category_test_data
    token = _make_rbac_token("super_admin", "platform", permissions=["view_audit_logs"])
    resp = client.get(
        "/audit-logs",
        params={"badge_number": data["badge"], "category": "user_management"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    logs = resp.json()["logs"]
    assert len(logs) == 1
    assert logs[0]["action"] == "reassign_posting"
