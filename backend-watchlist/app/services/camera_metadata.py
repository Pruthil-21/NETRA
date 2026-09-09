"""Camera metadata for the vehicle-trace view.

Looks up the real backend-registry `cameras` table first (same Postgres
instance — see database.py) since that's the actual source of truth for
every registered camera's name/coordinates/stream_id. The three demo
cameras (101/102/103) used by the scripted vehicle-trace replay predate
real camera registration and aren't rows in that table, so they fall back
to this hardcoded dict — keep it only for those ids; every real camera
resolves through the registry lookup below.
"""
from psycopg2.extras import RealDictCursor

DEMO_CAMERAS: dict[int, dict] = {
    101: {
        "camera_name": "Petlad Entry Checkpoint",
        "latitude": 22.4729,
        "longitude": 72.7938,
        "stream_id": 101,
    },
    102: {
        "camera_name": "Petlad Town Centre",
        "latitude": 22.4766,
        "longitude": 72.7994,
        "stream_id": 102,
    },
    103: {
        "camera_name": "Petlad Exit Checkpoint",
        "latitude": 22.4804,
        "longitude": 72.8051,
        "stream_id": 103,
    },
}


def lookup(db: RealDictCursor, camera_id: int) -> dict:
    """Returns camera metadata fields for a sighting: the real registered
    camera when one exists, the hardcoded demo entry for 101/102/103
    otherwise, or all-None fields for a truly unknown camera_id (never
    raises — a missing lookup shouldn't hide a real detection from the
    trace)."""
    db.execute(
        "SELECT name, ST_Y(location::geometry) AS latitude, ST_X(location::geometry) AS longitude, "
        "stream_id FROM cameras WHERE id = %s",
        (camera_id,),
    )
    row = db.fetchone()
    if row:
        return {
            "camera_name": row["name"],
            "latitude": row["latitude"],
            "longitude": row["longitude"],
            "stream_id": row["stream_id"],
        }
    return DEMO_CAMERAS.get(
        camera_id,
        {"camera_name": None, "latitude": None, "longitude": None, "stream_id": None},
    )
