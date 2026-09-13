"""One-off demo-data seed: gives Vadodara a second real-looking cluster of
traffic activity on the Map page's Density/Flow layers, alongside whatever
real Ahmedabad data already exists -- for presentation screenshots, not a
test fixture.

Safe to re-run any time (e.g. right before a demo, to refresh "live" mode):
cameras are created idempotently (skipped if a same-named one already
exists), and every detection this script inserts is re-run's own from
scratch, so nothing accumulates unbounded across runs. Every inserted row
carries source="demo-seed-vadodara" -- to remove all of it later:
    DELETE FROM detections WHERE source = 'demo-seed-vadodara';
    DELETE FROM cameras WHERE name IN (<the 4 names below>);

Seeds two independent timestamp sets so both Map-layer window modes work
whenever someone actually looks:
  - "today, 17:00-17:59 IST" -- reproducible indefinitely via Density/Flow's
    "By hour" -> 5 PM -> today, regardless of which day this is viewed.
  - "within the last ~15 minutes" -- shows up immediately in "Live" mode
    right after this script runs, decays after ~30-60 min like any real
    live window would.

Run: venv/Scripts/python.exe scripts/seed_vadodara_demo.py
"""
import os
import random
import sys
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import psycopg2
import psycopg2.extras

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.config import settings

_IST = ZoneInfo("Asia/Kolkata")
SOURCE_TAG = "demo-seed-vadodara"

# Real Vadodara landmarks -- a plausible, geographically sensible spread
# (not scattered randomly), close enough together that plate-to-plate
# transitions between them produce realistic city-traffic speeds.
CAMERAS = [
    {"name": "Sayajigunj Circle", "lat": 22.3149, "long": 73.1812, "target_count": 60},
    {"name": "Alkapuri Cross Roads", "lat": 22.3080, "long": 73.1673, "target_count": 35},
    {"name": "Fatehgunj Circle", "lat": 22.3225, "long": 73.1918, "target_count": 20},
    {"name": "Genda Circle", "lat": 22.2975, "long": 73.1893, "target_count": 12},
]

# (from_index, to_index, gap_minutes, transition_count) into CAMERAS above --
# each produces one Flow corridor. Gaps chosen for plausible city-traffic
# speeds (10-30 km/h) given the real distance between these two points, not
# picked arbitrarily.
CORRIDORS = [
    (0, 1, 5, 4),   # Sayajigunj -> Alkapuri, ~1.5km / 5min =~ 18km/h
    (1, 2, 8, 4),   # Alkapuri -> Fatehgunj, ~2.7km / 8min =~ 20km/h
    (2, 3, 6, 3),   # Fatehgunj -> Genda Circle, ~2.9km / 6min =~ 29km/h
]


def _random_plate() -> str:
    return f"GJ06{random.choice('ABCDEFGHJKLMNPQRSTUVWXYZ')}{uuid.uuid4().hex[:4].upper()}"


def _ensure_cameras(cur) -> list[int]:
    ids = []
    for cam in CAMERAS:
        cur.execute("SELECT id FROM cameras WHERE name = %s", (cam["name"],))
        row = cur.fetchone()
        if row:
            ids.append(row[0])
            continue
        cur.execute(
            """
            INSERT INTO cameras
                (name, dept, location, camera_type, ownership, connectivity_status,
                 storage_type, retention_days, health_status)
            VALUES (%s, 'Vadodara', ST_SetSRID(ST_MakePoint(%s, %s), 4326), 'fixed', 'govt',
                     'online', 'cloud', 30, 'healthy')
            RETURNING id
            """,
            (cam["name"], cam["long"], cam["lat"]),
        )
        ids.append(cur.fetchone()[0])
    return ids


def _clear_previous(cur, camera_ids: list[int]) -> None:
    cur.execute(
        "DELETE FROM detections WHERE source = %s AND camera_id = ANY(%s)",
        (SOURCE_TAG, camera_ids),
    )


def _insert_detection(cur, camera_id: int, plate: str, detected_at: datetime) -> None:
    cur.execute(
        "INSERT INTO detections (plate_number, camera_id, detected_at, source) VALUES (%s, %s, %s, %s)",
        (plate, camera_id, detected_at, SOURCE_TAG),
    )


def _seed_for_anchor(cur, camera_ids: list[int], anchor: datetime) -> None:
    """One full pass (corridors + density padding) anchored at `anchor` --
    called once for the persisted hour-bucket anchor and once for the
    live-window anchor, so both Map-layer window modes have real data."""
    counted = {cid: 0 for cid in camera_ids}

    for from_idx, to_idx, gap_minutes, transitions in CORRIDORS:
        from_id, to_id = camera_ids[from_idx], camera_ids[to_idx]
        for i in range(transitions):
            plate = _random_plate()
            t_from = anchor + timedelta(minutes=i * 2)
            t_to = t_from + timedelta(minutes=gap_minutes)
            _insert_detection(cur, from_id, plate, t_from)
            _insert_detection(cur, to_id, plate, t_to)
            counted[from_id] += 1
            counted[to_id] += 1

    for cam, cid in zip(CAMERAS, camera_ids):
        remaining = max(0, cam["target_count"] - counted[cid])
        for _ in range(remaining):
            offset_minutes = random.uniform(0, 25)
            _insert_detection(cur, cid, _random_plate(), anchor + timedelta(minutes=offset_minutes))


def main():
    conn = psycopg2.connect(settings.database_url)
    try:
        with conn.cursor() as cur:
            camera_ids = _ensure_cameras(cur)
            _clear_previous(cur, camera_ids)

            now_ist = datetime.now(_IST)
            hour_anchor = now_ist.replace(hour=17, minute=0, second=0, microsecond=0)
            live_anchor = now_ist - timedelta(minutes=15)

            _seed_for_anchor(cur, camera_ids, hour_anchor)
            _seed_for_anchor(cur, camera_ids, live_anchor)
        conn.commit()
        print(f"Seeded {len(CAMERAS)} Vadodara cameras (ids={camera_ids}) with demo detections.")
        print("Density: Map -> Density -> By hour -> 5 PM -> today, or Live (next ~30-60 min).")
        print("Flow: Map -> Flow -> same window choices.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
