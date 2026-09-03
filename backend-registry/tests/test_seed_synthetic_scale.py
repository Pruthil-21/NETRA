import pytest
from app.db import get_conn
from scripts.seed_synthetic_scale import cleanup, seed

# This file's tests (and seed()'s own reset=True default) do a blanket
# DELETE FROM cameras WHERE is_synthetic = true against whatever DATABASE_URL
# is configured -- the same connection string a real 80,000-row scale demo
# would live in. These tests only ever seed up to a few hundred rows
# themselves, so a populated table well beyond that is a strong signal this
# is a live-seeded demo database, not a throwaway test DB -- refuse to run
# rather than silently wiping it.
_LIVE_DEMO_SAFETY_THRESHOLD = 1000


@pytest.fixture(autouse=True)
def _refuse_to_run_against_a_live_seeded_demo_database():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM cameras WHERE is_synthetic = true")
            count = cur.fetchone()[0]
    if count > _LIVE_DEMO_SAFETY_THRESHOLD:
        pytest.fail(
            f"Refusing to run test_seed_synthetic_scale.py: found {count} synthetic camera "
            f"rows already in the database (safety threshold: {_LIVE_DEMO_SAFETY_THRESHOLD}). "
            "This looks like a live-seeded scale demo dataset -- this test file's cleanup "
            "helpers blanket-delete WHERE is_synthetic = true and WOULD DESTROY IT. "
            "Point DATABASE_URL at a disposable test database before running this file."
        )


def _cleanup():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM cameras WHERE is_synthetic = true")
            cur.execute("DELETE FROM edge_nodes WHERE is_synthetic = true")
        conn.commit()


def test_seed_inserts_the_requested_counts():
    _cleanup()
    result = seed(camera_count=250, edge_node_count=10)
    assert result == {"cameras_inserted": 250, "edge_nodes_inserted": 10}

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM cameras WHERE is_synthetic = true")
            assert cur.fetchone()[0] == 250
            cur.execute("SELECT COUNT(*) FROM edge_nodes WHERE is_synthetic = true")
            assert cur.fetchone()[0] == 10
    _cleanup()


def test_seed_is_idempotent_running_twice_does_not_double_the_counts():
    _cleanup()
    seed(camera_count=100, edge_node_count=5)
    result = seed(camera_count=100, edge_node_count=5)  # same call again
    assert result == {"cameras_inserted": 100, "edge_nodes_inserted": 5}

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM cameras WHERE is_synthetic = true")
            assert cur.fetchone()[0] == 100  # not 200
            cur.execute("SELECT COUNT(*) FROM edge_nodes WHERE is_synthetic = true")
            assert cur.fetchone()[0] == 5  # not 10
    _cleanup()


def test_seed_with_reset_false_appends_a_second_run_alongside_the_first():
    # reset=False is the explicit opt-in for "I want two runs coexisting,
    # tagged with different scale_run_ids" -- reset=True (the default) is
    # what makes bare `seed()` idempotent.
    _cleanup()
    first = seed(camera_count=50, edge_node_count=5)
    second = seed(camera_count=50, edge_node_count=5, reset=False)
    assert first == second == {"cameras_inserted": 50, "edge_nodes_inserted": 5}

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM cameras WHERE is_synthetic = true")
            assert cur.fetchone()[0] == 100  # both runs present
            cur.execute("SELECT COUNT(DISTINCT scale_run_id) FROM cameras WHERE is_synthetic = true")
            assert cur.fetchone()[0] == 2  # two distinct, taggable runs
    _cleanup()


def test_cleanup_removes_every_synthetic_row_and_nothing_else():
    _cleanup()
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO cameras (name, dept, location, camera_type, ownership,
                    connectivity_status, storage_type, retention_days, health_status, is_synthetic)
                VALUES ('Cleanup Test Real Camera', 'Traffic Police',
                    ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'ip', 'traffic-police',
                    'online', 'nvr', 15, 'operational', false)
                RETURNING id
            """)
            real_id = cur.fetchone()[0]
        conn.commit()

    seed(camera_count=40, edge_node_count=4)
    result = cleanup()
    assert result == {"cameras_deleted": 40, "edge_nodes_deleted": 4}

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM cameras WHERE is_synthetic = true")
            assert cur.fetchone()[0] == 0
            cur.execute("SELECT is_synthetic FROM cameras WHERE id = %s", (real_id,))
            assert cur.fetchone()[0] is False
            cur.execute("DELETE FROM cameras WHERE id = %s", (real_id,))
        conn.commit()


def test_seed_never_touches_real_rows():
    _cleanup()
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO cameras (name, dept, location, camera_type, ownership,
                    connectivity_status, storage_type, retention_days, health_status, is_synthetic)
                VALUES ('Real Camera Untouched', 'Traffic Police',
                    ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'ip', 'traffic-police',
                    'online', 'nvr', 15, 'operational', false)
                RETURNING id
            """)
            real_id = cur.fetchone()[0]
        conn.commit()

    seed(camera_count=50, edge_node_count=5)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT is_synthetic FROM cameras WHERE id = %s", (real_id,))
            assert cur.fetchone()[0] is False
            cur.execute("DELETE FROM cameras WHERE id = %s", (real_id,))
        conn.commit()
    _cleanup()


def test_synthetic_cameras_are_distributed_across_edge_nodes_and_marked_clearly():
    _cleanup()
    seed(camera_count=100, edge_node_count=10)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(DISTINCT edge_node_id) FROM cameras WHERE is_synthetic = true")
            assert cur.fetchone()[0] == 10
            cur.execute("SELECT name FROM cameras WHERE is_synthetic = true LIMIT 1")
            assert cur.fetchone()[0].startswith("SYN-CAM-")
    _cleanup()
