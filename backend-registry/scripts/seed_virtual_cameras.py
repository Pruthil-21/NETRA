"""Seeds one "virtual capture" camera row per district that already has real
cameras -- the Manual Plate Lookup feature dispatches every officer-uploaded
clip/image (or marked Archive range) against one of these, since detections/
alerts both require a real camera_id (NOT NULL) but an ad-hoc upload has no
actual registered camera. See schema.sql's cameras.is_virtual_capture.

Idempotent -- upserts by (dept, is_virtual_capture), safe to re-run.

Location: that district's police_stations HQ point when one exists, else the
centroid of that district's own real camera coordinates (no external
geocoding dependency -- self-contained and good enough, since this row is
never shown as a precise pin anywhere real cameras/analytics are excluded
from it by is_virtual_capture)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.db import get_conn

# Plain ASCII on purpose -- an em-dash here previously got mangled into a
# Unicode replacement character on the way into Postgres via this Windows
# console's default encoding.
VIRTUAL_CAMERA_NAME = "Field Capture - Handheld/Uploaded Footage"


def seed():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT DISTINCT dept FROM cameras WHERE is_synthetic = false AND is_virtual_capture = false"
            )
            districts = [row[0] for row in cur.fetchall()]

            for dept in districts:
                cur.execute(
                    "SELECT ST_Y(location::geometry), ST_X(location::geometry) "
                    "FROM police_stations WHERE district = %s LIMIT 1",
                    (dept,),
                )
                point = cur.fetchone()
                if point is None:
                    cur.execute(
                        "SELECT AVG(ST_Y(location::geometry)), AVG(ST_X(location::geometry)) "
                        "FROM cameras WHERE dept = %s AND is_synthetic = false AND is_virtual_capture = false",
                        (dept,),
                    )
                    point = cur.fetchone()
                lat, long = point

                cur.execute(
                    """
                    INSERT INTO cameras (
                        name, dept, location, camera_type, ownership,
                        connectivity_status, storage_type, retention_days,
                        health_status, is_virtual_capture
                    )
                    SELECT %(name)s, %(dept)s,
                           ST_SetSRID(ST_MakePoint(%(long)s, %(lat)s), 4326),
                           'mobile_handheld', 'department', 'unknown', 'none', 0,
                           'unknown', true
                    WHERE NOT EXISTS (
                        SELECT 1 FROM cameras WHERE dept = %(dept)s AND is_virtual_capture = true
                    )
                    """,
                    {"name": VIRTUAL_CAMERA_NAME, "dept": dept, "lat": lat, "long": long},
                )
        conn.commit()
    print(f"Seeded virtual capture cameras for {len(districts)} district(s): {districts}")


if __name__ == "__main__":
    seed()
