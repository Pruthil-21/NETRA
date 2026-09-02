"""Bulk-seeds synthetic edge nodes and cameras for the 80,000-camera scale
demo. COPY-based (never one INSERT + commit per row), fully additive --
never touches a real (is_synthetic=false) row. Every generated record is
marked synthetic three ways over: the is_synthetic flag, a SYN- name prefix
that survives even a raw SQL export or CSV dump, and a scale_run_id tagging
which invocation created it.

Idempotent by construction: seed()'s default reset=True deletes every
existing synthetic row before inserting, so re-running with the same
arguments always converges to exactly the requested counts, never
accumulating duplicates. Generation is deterministic (RANDOM_SEED below) --
the same camera_count/edge_node_count always produces the same
lat/long/status distribution, which is what makes idempotency actually
meaningful (a second run isn't just "the same count," it's "the same data").

Run directly for the full 80,000/800 demo scale:
    venv/Scripts/python.exe scripts/seed_synthetic_scale.py
    venv/Scripts/python.exe scripts/seed_synthetic_scale.py --cleanup
Or import seed(camera_count, edge_node_count)/cleanup() for a smaller
run (tests do; tests always pass small counts, never the full 80,000).
"""
import argparse
import io
import os
import random
import sys
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.db import get_conn  # noqa: E402

# Gujarat's rough bounding box -- plausible map scatter, not real locations.
LAT_RANGE = (20.5, 24.5)
LONG_RANGE = (68.5, 74.5)

# Fixes the sequence random.uniform/choice/choices draw from -- not a
# security concern (this is synthetic demo data), just what makes repeated
# seed() calls produce identical output, so idempotency covers the actual
# generated fields, not only the row counts.
RANDOM_SEED = 80_000

DISTRICTS = [
    "Ahmedabad", "Surat", "Vadodara", "Rajkot", "Bhavnagar", "Jamnagar",
    "Junagadh", "Gandhinagar", "Anand", "Mehsana", "Kutch", "Patan",
    "Kheda", "Sabarkantha", "Banaskantha", "Panchmahal", "Dahod", "Bharuch",
    "Narmada", "Navsari", "Valsad", "Tapi", "Dang", "Porbandar",
    "Amreli", "Botad", "Surendranagar", "Morbi", "Devbhoomi Dwarka",
    "Gir Somnath", "Aravalli", "Mahisagar", "Chhota Udepur",
]

CAMERA_TYPES = ["ip", "PTZ", "Dome", "Bullet"]
STORAGE_TYPES = ["nvr", "cloud", "hybrid"]
# Weighted so the summary endpoint (Task 4) has a realistic, non-trivial
# online/degraded/offline split to display, not an all-green demo.
CONNECTIVITY_WEIGHTS = [("online", 0.85), ("degraded", 0.10), ("offline", 0.05)]
HEALTH_WEIGHTS = [("operational", 0.80), ("degraded", 0.15), ("fault", 0.05)]


def _weighted_choice(weights: list[tuple[str, float]]) -> str:
    return random.choices([w[0] for w in weights], weights=[w[1] for w in weights], k=1)[0]


def _seed_edge_nodes(conn, count: int, run_id: str) -> list[int]:
    buf = io.StringIO()
    for i in range(count):
        district = DISTRICTS[i % len(DISTRICTS)]
        buf.write(f"SYN-EDGE-{i + 1:04d}\t{district}\ttrue\t{run_id}\n")
    buf.seek(0)

    with conn.cursor() as cur:
        with cur.copy("COPY edge_nodes (name, district, is_synthetic, scale_run_id) FROM STDIN") as copy:
            copy.write(buf.read())
        cur.execute(
            "SELECT id FROM edge_nodes WHERE scale_run_id = %s ORDER BY id",
            (run_id,),
        )
        ids = [row[0] for row in cur.fetchall()]
    conn.commit()
    return ids


def _seed_cameras(conn, count: int, edge_node_ids: list[int], run_id: str) -> None:
    buf = io.StringIO()
    for i in range(count):
        edge_node_id = edge_node_ids[i % len(edge_node_ids)]
        district = DISTRICTS[i % len(DISTRICTS)]
        lat = random.uniform(*LAT_RANGE)
        long = random.uniform(*LONG_RANGE)
        camera_type = random.choice(CAMERA_TYPES)
        storage_type = random.choice(STORAGE_TYPES)
        connectivity = _weighted_choice(CONNECTIVITY_WEIGHTS)
        health = _weighted_choice(HEALTH_WEIGHTS)
        buf.write(
            f"SYN-CAM-{i + 1:06d}\t{district}\tSRID=4326;POINT({long} {lat})\t"
            f"{camera_type}\tsynthetic-scale-demo\t{connectivity}\t{storage_type}\t"
            f"15\t{health}\ttrue\t{edge_node_id}\t{run_id}\n"
        )
    buf.seek(0)

    with conn.cursor() as cur:
        with cur.copy(
            "COPY cameras (name, dept, location, camera_type, ownership, "
            "connectivity_status, storage_type, retention_days, health_status, "
            "is_synthetic, edge_node_id, scale_run_id) FROM STDIN"
        ) as copy:
            copy.write(buf.read())
    conn.commit()


def cleanup() -> dict:
    """Deletes every synthetic row -- scoped strictly to is_synthetic = true,
    so a real camera/edge node can never be touched. The explicit teardown
    command requirement 1's isolation calls for, independent of reseeding."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM cameras WHERE is_synthetic = true")
            cameras_deleted = cur.rowcount
            cur.execute("DELETE FROM edge_nodes WHERE is_synthetic = true")
            edge_nodes_deleted = cur.rowcount
        conn.commit()
    return {"cameras_deleted": cameras_deleted, "edge_nodes_deleted": edge_nodes_deleted}


def seed(camera_count: int = 80_000, edge_node_count: int = 800, reset: bool = True) -> dict:
    """reset=True (default): delete existing synthetic rows first, so this
    call is idempotent -- running it N times leaves exactly camera_count/
    edge_node_count synthetic rows, not N times that. reset=False is the
    explicit opt-in to let a new run's rows coexist with a prior run's,
    each tagged with its own scale_run_id."""
    random.seed(RANDOM_SEED)
    if reset:
        cleanup()

    run_id = str(uuid.uuid4())
    with get_conn() as conn:
        edge_node_ids = _seed_edge_nodes(conn, edge_node_count, run_id)
        _seed_cameras(conn, camera_count, edge_node_ids, run_id)
    return {"cameras_inserted": camera_count, "edge_nodes_inserted": edge_node_count}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cleanup", action="store_true", help="Remove all synthetic rows and exit, without reseeding.")
    args = parser.parse_args()

    if args.cleanup:
        result = cleanup()
        print(f"Removed {result['cameras_deleted']} synthetic cameras and "
              f"{result['edge_nodes_deleted']} synthetic edge nodes.")
    else:
        result = seed()
        print(f"Seeded {result['edge_nodes_inserted']} synthetic edge nodes and "
              f"{result['cameras_inserted']} synthetic cameras.")
