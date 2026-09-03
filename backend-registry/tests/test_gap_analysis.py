from datetime import datetime, timedelta, timezone

from app.db import get_conn
from app.services import gap_analysis_service


def _insert_camera(cur, name, lat, long, dept="Test Dept", created_at=None):
    cur.execute(
        """
        INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days, created_at)
        VALUES (%s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), 'fixed', 'govt', 'cloud', 30, COALESCE(%s, now()))
        RETURNING id
        """,
        (name, dept, long, lat, created_at),
    )
    return cur.fetchone()[0]


def _insert_target(cur, name, lat, long, district="Test Dept"):
    cur.execute(
        """
        INSERT INTO coverage_targets (name, location, district)
        VALUES (%s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), %s)
        RETURNING id
        """,
        (name, long, lat, district),
    )
    return cur.fetchone()[0]


def test_target_within_threshold_is_not_a_gap():
    with get_conn() as conn:
        with conn.cursor() as cur:
            # ~99m north of the camera (1 degree lat ~= 111km, so 0.00089deg ~= 99m)
            cam_id = _insert_camera(cur, "Gap Test Cam A", 10.0, 10.0)
            target_id = _insert_target(cur, "Near Target", 10.00089, 10.0)
            conn.commit()

        zones = gap_analysis_service.compute_uncovered_zones(conn, threshold_m=100)
        assert not any(z["target_id"] == target_id for z in zones)

        with conn.cursor() as cur:
            cur.execute("DELETE FROM coverage_targets WHERE id = %s", (target_id,))
            cur.execute("DELETE FROM cameras WHERE id = %s", (cam_id,))
        conn.commit()


def test_target_beyond_threshold_is_a_gap():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cam_id = _insert_camera(cur, "Gap Test Cam B", 10.0, 10.0)
            # ~111m north -- just past 100m
            target_id = _insert_target(cur, "Far Target", 10.001, 10.0)
            conn.commit()

        zones = gap_analysis_service.compute_uncovered_zones(conn, threshold_m=100)
        matching = [z for z in zones if z["target_id"] == target_id]
        assert len(matching) == 1
        assert matching[0]["nearest_camera_id"] == cam_id
        assert matching[0]["distance_meters"] > 100

        with conn.cursor() as cur:
            cur.execute("DELETE FROM coverage_targets WHERE id = %s", (target_id,))
            cur.execute("DELETE FROM cameras WHERE id = %s", (cam_id,))
        conn.commit()


def test_target_with_zero_cameras_reports_none():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM cameras")  # isolated: relies on test DB being otherwise empty of cameras
            target_id = _insert_target(cur, "Orphan Target", 5.0, 5.0)
            conn.commit()

        zones = gap_analysis_service.compute_uncovered_zones(conn, threshold_m=100)
        matching = [z for z in zones if z["target_id"] == target_id]
        assert len(matching) == 1
        assert matching[0]["nearest_camera_id"] is None
        assert matching[0]["distance_meters"] is None

        with conn.cursor() as cur:
            cur.execute("DELETE FROM coverage_targets WHERE id = %s", (target_id,))
        conn.commit()


def test_ageing_infrastructure_ranks_unstable_old_cameras_first():
    old_stable_created = datetime.now(timezone.utc) - timedelta(days=1200)
    old_unstable_created = datetime.now(timezone.utc) - timedelta(days=1300)
    young_created = datetime.now(timezone.utc) - timedelta(days=30)

    with get_conn() as conn:
        with conn.cursor() as cur:
            stable_id = _insert_camera(cur, "Old Stable", 20.0, 20.0, created_at=old_stable_created)
            unstable_id = _insert_camera(cur, "Old Unstable", 21.0, 21.0, created_at=old_unstable_created)
            young_id = _insert_camera(cur, "Young Cam", 22.0, 22.0, created_at=young_created)
            for _ in range(3):
                cur.execute(
                    "INSERT INTO camera_status_history (camera_id, connectivity_status) VALUES (%s, 'offline')",
                    (unstable_id,),
                )
            conn.commit()

        results = gap_analysis_service.compute_ageing_infrastructure(conn, age_threshold_days=1095)
        ids_in_order = [r["camera_id"] for r in results]
        assert young_id not in ids_in_order
        assert unstable_id in ids_in_order and stable_id in ids_in_order
        assert ids_in_order.index(unstable_id) < ids_in_order.index(stable_id)

        with conn.cursor() as cur:
            cur.execute("DELETE FROM camera_status_history WHERE camera_id = %s", (unstable_id,))
            cur.execute("DELETE FROM cameras WHERE id = ANY(%s)", ([stable_id, unstable_id, young_id],))
        conn.commit()


def test_gap_analysis_report_endpoint_shape(client, officer_headers):
    resp = client.get("/reports/gap-analysis", headers=officer_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert "uncovered_zones" in body
    assert "ageing_infrastructure" in body
    assert isinstance(body["uncovered_zones"], list)
    assert isinstance(body["ageing_infrastructure"], list)
