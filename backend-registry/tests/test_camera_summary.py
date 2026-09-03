from app.db import get_conn


def _seed(conn):
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO cameras (name, dept, location, camera_type, ownership,
                connectivity_status, storage_type, retention_days, health_status, is_synthetic)
            VALUES
            ('Summary Test Real Online', 'Traffic Police', ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326),
                'ip', 'traffic-police', 'online', 'nvr', 15, 'operational', false),
            ('Summary Test Synthetic Online', 'Test District', ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326),
                'ip', 'synthetic-scale-demo', 'online', 'nvr', 15, 'operational', true),
            ('Summary Test Synthetic Degraded', 'Test District', ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326),
                'ip', 'synthetic-scale-demo', 'degraded', 'nvr', 15, 'degraded', true),
            ('Summary Test Synthetic Offline', 'Test District', ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326),
                'ip', 'synthetic-scale-demo', 'offline', 'nvr', 15, 'fault', true)
        """)
        cur.execute("INSERT INTO edge_nodes (name, district, is_synthetic) VALUES ('Summary Test Edge', 'Test District', true)")
    conn.commit()


def _cleanup(conn):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM cameras WHERE name LIKE 'Summary Test%'")
        cur.execute("DELETE FROM edge_nodes WHERE name LIKE 'Summary Test%'")
    conn.commit()


def test_summary_counts_are_correct(client, officer_headers, monkeypatch):
    monkeypatch.setenv("SCALE_DEMO_ENABLED", "true")
    with get_conn() as conn:
        _seed(conn)

    resp = client.get("/cameras/summary", headers=officer_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] >= 4
    assert body["online"] >= 2
    assert body["degraded"] >= 1
    assert body["offline"] >= 1
    assert body["edge_node_count"] >= 1
    assert body["real_stream_count"] >= 1
    assert body["synthetic_count"] >= 3

    with get_conn() as conn:
        _cleanup(conn)


def test_summary_requires_auth(client, monkeypatch):
    monkeypatch.setenv("SCALE_DEMO_ENABLED", "true")
    resp = client.get("/cameras/summary")
    assert resp.status_code == 401


def test_summary_is_404_when_the_scale_demo_flag_is_off(client, officer_headers, monkeypatch):
    monkeypatch.delenv("SCALE_DEMO_ENABLED", raising=False)
    resp = client.get("/cameras/summary", headers=officer_headers)
    assert resp.status_code == 404


def test_district_grouping_returns_real_aggregate_counts_not_a_truncated_page(client, officer_headers, monkeypatch):
    monkeypatch.setenv("SCALE_DEMO_ENABLED", "true")
    with get_conn() as conn:
        with conn.cursor() as cur:
            # 600 rows in one district -- bigger than any single page (Task 3's
            # MAX_PAGE_LIMIT is 500), so a correct group_by must report 600,
            # not be capped at whatever one page would have held.
            rows = ",\n".join(
                f"('Summary District Test Camera {i}', 'Summary District Test District', "
                f"ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'ip', 'synthetic-scale-demo', "
                f"'online', 'nvr', 15, 'operational', true)"
                for i in range(600)
            )
            cur.execute(f"""
                INSERT INTO cameras (name, dept, location, camera_type, ownership,
                    connectivity_status, storage_type, retention_days, health_status, is_synthetic)
                VALUES {rows}
            """)
        conn.commit()

    resp = client.get(
        "/cameras/summary?group_by=district&min_lat=22&max_lat=24&min_long=71&max_long=74",
        headers=officer_headers,
    )
    assert resp.status_code == 200
    districts = {d["district"]: d["count"] for d in resp.json()["districts"]}
    assert districts.get("Summary District Test District") == 600

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM cameras WHERE dept = 'Summary District Test District'")
        conn.commit()
