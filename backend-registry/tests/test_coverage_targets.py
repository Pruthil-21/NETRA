from app.db import get_conn


def test_create_and_get_coverage_target(client, officer_headers, gap_analysis_test_targets):
    resp = client.post(
        "/coverage-targets",
        json={"name": "MG Road Junction", "lat": 23.0225, "long": 72.5714, "district": "Traffic Police", "priority": "high"},
        headers=officer_headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    gap_analysis_test_targets.append(body["id"])
    assert body["name"] == "MG Road Junction"
    assert body["priority"] == "high"
    assert abs(body["lat"] - 23.0225) < 0.001
    assert abs(body["long"] - 72.5714) < 0.001

    get_resp = client.get(f"/coverage-targets/{body['id']}", headers=officer_headers)
    assert get_resp.status_code == 200
    assert get_resp.json()["name"] == "MG Road Junction"


def test_create_coverage_target_requires_manage_cameras_permission(client):
    import jwt
    from app.config import settings

    token = jwt.encode({"sub": "no-perms", "role": "viewer"}, settings.jwt_secret, algorithm="HS256")
    resp = client.post(
        "/coverage-targets",
        json={"name": "X", "lat": 23.0, "long": 72.5, "district": "Traffic Police"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


def test_list_coverage_targets(client, officer_headers, gap_analysis_test_targets):
    create_resp = client.post(
        "/coverage-targets",
        json={"name": "List Test Target", "lat": 23.01, "long": 72.55, "district": "Traffic Police"},
        headers=officer_headers,
    )
    target_id = create_resp.json()["id"]
    gap_analysis_test_targets.append(target_id)

    list_resp = client.get("/coverage-targets", headers=officer_headers)
    assert list_resp.status_code == 200
    assert any(t["id"] == target_id for t in list_resp.json())


def test_update_and_delete_coverage_target(client, officer_headers, gap_analysis_test_targets):
    create_resp = client.post(
        "/coverage-targets",
        json={"name": "Update Test", "lat": 23.02, "long": 72.56, "district": "Traffic Police"},
        headers=officer_headers,
    )
    target_id = create_resp.json()["id"]
    gap_analysis_test_targets.append(target_id)

    update_resp = client.put(
        f"/coverage-targets/{target_id}",
        json={"priority": "low"},
        headers=officer_headers,
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["priority"] == "low"

    delete_resp = client.delete(f"/coverage-targets/{target_id}", headers=officer_headers)
    assert delete_resp.status_code == 204

    get_resp = client.get(f"/coverage-targets/{target_id}", headers=officer_headers)
    assert get_resp.status_code == 404


def test_update_with_only_lat_does_not_500(client, officer_headers, gap_analysis_test_targets):
    """Regression test: update_target used to build an empty SET clause list
    when only one of lat/long was supplied (both are required together to
    rebuild the `location` column), producing invalid SQL
    ("UPDATE coverage_targets SET  WHERE ...") and an unhandled 500. A lone
    lat/long with nothing else to update is now treated as a no-op."""
    create_resp = client.post(
        "/coverage-targets",
        json={"name": "Partial Update Test", "lat": 23.03, "long": 72.57, "district": "Traffic Police"},
        headers=officer_headers,
    )
    target_id = create_resp.json()["id"]
    gap_analysis_test_targets.append(target_id)

    update_resp = client.put(
        f"/coverage-targets/{target_id}",
        json={"lat": 23.5},
        headers=officer_headers,
    )
    assert update_resp.status_code == 200
    body = update_resp.json()
    # No-op: the lone lat is dropped since long wasn't supplied alongside it,
    # so the target's coordinates are unchanged.
    assert abs(body["lat"] - 23.03) < 0.001
    assert abs(body["long"] - 72.57) < 0.001


def test_coverage_targets_table_exists():
    """Guards against Finding 4: schema.sql only auto-applies via
    docker-entrypoint-initdb.d on a fresh Postgres volume. Any environment
    with an existing volume (a teammate's machine, a persisted CI volume,
    staging) won't have the coverage_targets table unless someone manually
    applies the migration -- and a missing table currently degrades silently
    to an empty report (see /reports/gap-analysis's except blocks) rather
    than failing loudly. This test converts that into a named failure."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = %s)",
                ("coverage_targets",),
            )
            exists = cur.fetchone()[0]
    assert exists, (
        "coverage_targets table is missing -- schema.sql was not applied to this "
        "Postgres instance (it only auto-runs via docker-entrypoint-initdb.d on a "
        "fresh volume). Apply the migration manually before running this suite."
    )
