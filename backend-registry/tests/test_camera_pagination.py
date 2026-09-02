from app.db import get_conn


def _seed_synthetic(conn, n=30):
    with conn.cursor() as cur:
        for i in range(n):
            cur.execute("""
                INSERT INTO cameras (name, dept, location, camera_type, ownership,
                    connectivity_status, storage_type, retention_days, health_status, is_synthetic)
                VALUES (%s, 'Test District', ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326),
                    'ip', 'synthetic-scale-demo', 'online', 'nvr', 15, 'operational', true)
            """, (f"Pagination Test Camera {i}",))
    conn.commit()


def _cleanup(conn):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM cameras WHERE name LIKE 'Pagination Test Camera%'")
    conn.commit()


def test_default_call_excludes_synthetic_and_returns_everything_unpaginated(client, officer_headers):
    with get_conn() as conn:
        _seed_synthetic(conn)
    resp = client.get("/cameras", headers=officer_headers)
    assert resp.status_code == 200
    body = resp.json()
    # Legacy shape: a bare list, not the new {"cameras": [...]} envelope --
    # existing callers (CameraRegistryContext.tsx) parse the response as
    # response.json() and expect an array directly.
    assert isinstance(body, list)
    assert all("Pagination Test Camera" not in c["name"] for c in body)
    with get_conn() as conn:
        _cleanup(conn)


def test_include_synthetic_with_limit_returns_a_capped_page_and_a_cursor(client, officer_headers, monkeypatch):
    monkeypatch.setenv("SCALE_DEMO_ENABLED", "true")
    with get_conn() as conn:
        _seed_synthetic(conn, n=30)

    resp = client.get("/cameras?include_synthetic=true&limit=10", headers=officer_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, dict)
    assert len(body["cameras"]) == 10
    assert body["next_cursor"] is not None

    resp2 = client.get(f"/cameras?include_synthetic=true&limit=10&cursor={body['next_cursor']}", headers=officer_headers)
    body2 = resp2.json()
    assert len(body2["cameras"]) == 10
    assert {c["id"] for c in body["cameras"]}.isdisjoint({c["id"] for c in body2["cameras"]})

    with get_conn() as conn:
        _cleanup(conn)


def test_limit_is_capped_server_side_even_if_a_huge_value_is_requested(client, officer_headers, monkeypatch):
    monkeypatch.setenv("SCALE_DEMO_ENABLED", "true")
    with get_conn() as conn:
        _seed_synthetic(conn, n=30)

    resp = client.get("/cameras?include_synthetic=true&limit=100000", headers=officer_headers)
    body = resp.json()
    assert len(body["cameras"]) <= 500  # server-enforced cap, never "all rows"

    with get_conn() as conn:
        _cleanup(conn)


def test_bbox_filter_excludes_cameras_outside_the_box(client, officer_headers, monkeypatch):
    # Coordinates deliberately sit far from the seeded real-camera region (Gujarat) --
    # this dev DB has ~294 real cameras, most of them inside that region, and the
    # endpoint's default limit=100 (ORDER BY id) would silently truncate this test's
    # own rows out of the result before they're ever reached if the box overlapped
    # real data. Null-island-adjacent coordinates guarantee only this test's own
    # rows can match.
    monkeypatch.setenv("SCALE_DEMO_ENABLED", "true")
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO cameras (name, dept, location, camera_type, ownership,
                    connectivity_status, storage_type, retention_days, health_status, is_synthetic)
                VALUES ('Pagination Test Camera Inside Box', 'Test District',
                    ST_SetSRID(ST_MakePoint(1.0, 1.0), 4326), 'ip', 'synthetic-scale-demo',
                    'online', 'nvr', 15, 'operational', true),
                ('Pagination Test Camera Outside Box', 'Test District',
                    ST_SetSRID(ST_MakePoint(-10.0, -10.0), 4326), 'ip', 'synthetic-scale-demo',
                    'online', 'nvr', 15, 'operational', true)
            """)
        conn.commit()

    resp = client.get(
        "/cameras?include_synthetic=true&min_lat=0&max_lat=2&min_long=0&max_long=2",
        headers=officer_headers,
    )
    names = {c["name"] for c in resp.json()["cameras"]}
    assert "Pagination Test Camera Inside Box" in names
    assert "Pagination Test Camera Outside Box" not in names

    with get_conn() as conn:
        _cleanup(conn)


def test_list_cameras_service_function_never_returns_synthetic_rows(client, officer_headers):
    # Defense in depth: this calls cameras_service.list_cameras directly, not
    # through the route -- proves the SQL-level filter holds even if some
    # future caller reaches this function a different way than main.py does.
    from app.db import get_conn as _get_conn
    from app.services.cameras_service import list_cameras

    with _get_conn() as conn:
        _seed_synthetic(conn, n=10)
        rows = list_cameras(conn)
        assert all("Pagination Test Camera" not in r["name"] for r in rows)
        _cleanup(conn)


def test_include_synthetic_is_404_when_the_scale_demo_flag_is_off(client, officer_headers, monkeypatch):
    monkeypatch.delenv("SCALE_DEMO_ENABLED", raising=False)
    resp = client.get("/cameras?include_synthetic=true", headers=officer_headers)
    assert resp.status_code == 404


def test_include_synthetic_is_403_for_a_role_without_manage_cameras(client, monkeypatch):
    import jwt as pyjwt

    from app.config import settings

    monkeypatch.setenv("SCALE_DEMO_ENABLED", "true")
    token = pyjwt.encode(
        {"sub": "1", "badge_number": "GJ-CR-001", "role": "control_room_operator",
         "scope_type": "district", "scope_value": "Traffic Police",
         "permissions": ["view_live_feeds", "acknowledge_alerts"]},
        settings.jwt_secret, algorithm="HS256",
    )
    resp = client.get("/cameras?include_synthetic=true", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403
