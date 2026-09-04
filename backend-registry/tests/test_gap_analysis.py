from datetime import datetime, timedelta, timezone

from app.db import get_conn
from app.services import gap_analysis_service


def _insert_camera(cur, name, lat, long, dept="Test Dept", created_at=None, is_synthetic=False):
    cur.execute(
        """
        INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days, created_at, is_synthetic)
        VALUES (%s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), 'fixed', 'govt', 'cloud', 30, COALESCE(%s, now()), %s)
        RETURNING id
        """,
        (name, dept, long, lat, created_at, is_synthetic),
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


def test_target_within_threshold_is_not_a_gap(gap_analysis_test_cameras, gap_analysis_test_targets):
    with get_conn() as conn:
        with conn.cursor() as cur:
            # ~99m north of the camera (1 degree lat ~= 111km, so 0.00089deg ~= 99m)
            cam_id = _insert_camera(cur, "Gap Test Cam A", 10.0, 10.0)
            gap_analysis_test_cameras.append(cam_id)
            target_id = _insert_target(cur, "Near Target", 10.00089, 10.0)
            gap_analysis_test_targets.append(target_id)
            conn.commit()

        zones = gap_analysis_service.compute_uncovered_zones(conn, threshold_m=100)
        assert not any(z["target_id"] == target_id for z in zones)


def test_target_beyond_threshold_is_a_gap(gap_analysis_test_cameras, gap_analysis_test_targets):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cam_id = _insert_camera(cur, "Gap Test Cam B", 10.0, 10.0)
            gap_analysis_test_cameras.append(cam_id)
            # ~111m north -- just past 100m
            target_id = _insert_target(cur, "Far Target", 10.001, 10.0)
            gap_analysis_test_targets.append(target_id)
            conn.commit()

        zones = gap_analysis_service.compute_uncovered_zones(conn, threshold_m=100)
        matching = [z for z in zones if z["target_id"] == target_id]
        assert len(matching) == 1
        assert matching[0]["nearest_camera_id"] == cam_id
        assert matching[0]["distance_meters"] > 100


def test_synthetic_camera_ignored_in_uncovered_zones(gap_analysis_test_cameras, gap_analysis_test_targets):
    """A synthetic (is_synthetic=true) camera placed well within threshold of
    a coverage target must NOT count as coverage -- this is an
    infrastructure-planning report about real assets, so scale-demo data
    (seed_synthetic_scale.py can seed up to 80,000 synthetic cameras) must
    never mask a genuine gap or be surfaced as a "nearest camera"."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            synthetic_cam_id = _insert_camera(cur, "Synthetic Cam Near Target", 15.0, 15.0, is_synthetic=True)
            gap_analysis_test_cameras.append(synthetic_cam_id)
            # ~11m north of the synthetic camera -- well within the 100m threshold
            target_id = _insert_target(cur, "Target Near Synthetic Cam Only", 15.0001, 15.0)
            gap_analysis_test_targets.append(target_id)
            conn.commit()

        zones = gap_analysis_service.compute_uncovered_zones(conn, threshold_m=100)
        matching = [z for z in zones if z["target_id"] == target_id]
        assert len(matching) == 1, "synthetic camera must be ignored -- target should still be an uncovered zone"
        # The synthetic camera (~11m away) must never be reported as the
        # nearest camera -- whatever the LATERAL join finds instead (a real
        # camera elsewhere, or none at all) must be much farther than 100m,
        # proving the ~11m-away synthetic camera was correctly excluded.
        assert matching[0]["nearest_camera_id"] != synthetic_cam_id
        assert matching[0]["distance_meters"] is None or matching[0]["distance_meters"] > 100


def test_target_with_zero_cameras_reports_none():
    """Uses a transaction that is explicitly rolled back, never committed --
    this test must never actually delete real camera data from the shared
    dev database (see incident notes: an earlier version of this test did
    exactly that and required manual recovery from backup CSVs)."""
    with get_conn() as conn:
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM cameras")
                target_id = _insert_target(cur, "Orphan Target", 5.0, 5.0)

            zones = gap_analysis_service.compute_uncovered_zones(conn, threshold_m=100)
            matching = [z for z in zones if z["target_id"] == target_id]
            assert len(matching) == 1
            assert matching[0]["nearest_camera_id"] is None
            assert matching[0]["distance_meters"] is None
        finally:
            conn.rollback()


def test_ageing_infrastructure_ranks_unstable_old_cameras_first(gap_analysis_test_cameras):
    old_stable_created = datetime.now(timezone.utc) - timedelta(days=1200)
    old_unstable_created = datetime.now(timezone.utc) - timedelta(days=1300)
    young_created = datetime.now(timezone.utc) - timedelta(days=30)

    with get_conn() as conn:
        with conn.cursor() as cur:
            stable_id = _insert_camera(cur, "Old Stable", 20.0, 20.0, created_at=old_stable_created)
            gap_analysis_test_cameras.append(stable_id)
            unstable_id = _insert_camera(cur, "Old Unstable", 21.0, 21.0, created_at=old_unstable_created)
            gap_analysis_test_cameras.append(unstable_id)
            young_id = _insert_camera(cur, "Young Cam", 22.0, 22.0, created_at=young_created)
            gap_analysis_test_cameras.append(young_id)
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


def test_gap_analysis_report_endpoint_shape(client, officer_headers):
    resp = client.get("/reports/gap-analysis", headers=officer_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert "uncovered_zones" in body
    assert "ageing_infrastructure" in body
    assert isinstance(body["uncovered_zones"], list)
    assert isinstance(body["ageing_infrastructure"], list)
