"""One-time seed: register the organizer's 30 live cameras + the standalone
phone test rig into backend-registry, so frontend-dashboard can see them via
GET /cameras instead of only frontend-map's own client-side code.

Coordinates for the 30 organizer cameras are geocoded guesses (frontend-map
hand-geocoded each camera's free-text `location` label against OSM/Nominatim,
offline, one-time) — not survey data. See frontend-map/lib/organizerCameraCoords.ts
for the confidence rating ('landmark' / 'city' / 'unknown') behind each one.

Safe to re-run: skips any camera whose stream_id already exists in the table,
so it won't create duplicates on a second run.

Usage:
    venv/bin/python scripts/seed_cameras.py
    NETRA_PHONE_CAM_HLS_URL=https://<current-tunnel>.trycloudflare.com/... \\
        venv/bin/python scripts/seed_cameras.py
"""
import json
import os
import ssl
import sys
import urllib.request
from pathlib import Path

import certifi

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.db import get_conn
from app.services import cameras_service

ORGANIZER_API_URL = "https://live.corp8.cloud/api/cameras"

GUJARAT_CENTER = (22.2587, 71.1924)

# id -> (lat, long) — see frontend-map/lib/organizerCameraCoords.ts for the
# confidence rating and reasoning behind each entry.
ORGANIZER_CAMERA_COORDS = {
    1: (23.0225, 72.5714), 2: (23.0225, 72.5714), 3: (23.1012, 72.0529),
    4: (23.0175, 72.5645), 5: (23.1155, 72.6132), 6: (21.5033, 70.4335),
    7: (20.9298, 70.7628), 8: (21.5222, 70.4579), 9: (21.5220, 70.4582),
    10: (21.5225, 70.4585), 11: (21.5588, 70.4659), 12: (23.1785, 72.5721),
    13: (23.0184, 72.5512), 14: (23.0225, 72.5714), 15: (23.0225, 72.5714),
    16: (23.1155, 72.6132), 17: (22.3039, 70.8022), 18: (22.3053, 70.8028),
    19: (20.8389, 73.0240), 20: GUJARAT_CENTER, 21: (23.7738, 71.6799),
    22: GUJARAT_CENTER, 23: GUJARAT_CENTER, 24: (23.1640, 72.8818),
    25: (20.8389, 73.0240), 26: (20.8606, 73.1306), 27: (20.7672, 72.9693),
    28: (20.7692, 72.9713), 29: (20.7652, 72.9673), 30: (23.0719, 70.1317),
}


def fetch_organizer_cameras() -> list[dict]:
    ctx = ssl.create_default_context(cafile=certifi.where())
    # Plain urllib's default User-Agent gets a 403 from this API; curl's doesn't.
    req = urllib.request.Request(ORGANIZER_API_URL, headers={"User-Agent": "curl/8.7.1"})
    with urllib.request.urlopen(req, timeout=10, context=ctx) as res:
        data = json.load(res)
    return data if isinstance(data, list) else data.get("cameras") or data.get("data") or []


def organizer_camera_to_row(raw: dict) -> dict:
    camera_id = int(raw["id"])
    lat, long_ = ORGANIZER_CAMERA_COORDS.get(camera_id, GUJARAT_CENTER)
    # width > 0 is only a preliminary signal from the organizer's transcoder —
    # actual HLS playback success/failure is the final word on live status.
    has_preliminary_signal = (raw.get("width") or 0) > 0

    return {
        "name": raw.get("name") or f"Camera {raw['id']}",
        "dept": raw.get("location") or "Unknown location",
        "lat": lat,
        "long": long_,
        "camera_type": "Bullet",
        "ownership": "Event Organizer",
        "connectivity_status": "online" if has_preliminary_signal else "offline",
        "storage_type": "Cloud",
        "retention_days": 0,
        "health_status": "operational" if has_preliminary_signal else "degraded",
        "rtsp_url": raw.get("rtsp_url") or None,
        "stream_id": str(camera_id),
        "hls_url": None,
    }


def phone_test_rig_row() -> dict:
    hls_url = os.environ.get("NETRA_PHONE_CAM_HLS_URL")
    if not hls_url:
        print(
            "WARNING: NETRA_PHONE_CAM_HLS_URL not set — inserting 'Pruthil's Phone' "
            "with no hls_url. Get the current tunnel URL and re-run, or PATCH "
            "hls_url onto it later via PUT /cameras/{id}.",
            file=sys.stderr,
        )
    return {
        "name": "Pruthil's Phone",
        "dept": "Petlad, Gujarat",
        "lat": 22.4768,
        "long": 72.7999,
        "camera_type": "Bullet",
        "ownership": "NETRA Test Rig",
        "connectivity_status": "offline",
        "storage_type": "Cloud",
        "retention_days": 0,
        "health_status": "degraded",
        "rtsp_url": None,
        "stream_id": "9001",
        "hls_url": hls_url,
    }


def existing_stream_ids(conn) -> set[str]:
    with conn.cursor() as cur:
        cur.execute("SELECT stream_id FROM cameras WHERE stream_id IS NOT NULL")
        return {row[0] for row in cur.fetchall()}


def main():
    rows = [organizer_camera_to_row(raw) for raw in fetch_organizer_cameras()]
    rows.append(phone_test_rig_row())

    conn = get_conn()
    already_seeded = existing_stream_ids(conn)

    created, skipped = 0, 0
    for row in rows:
        if row["stream_id"] in already_seeded:
            skipped += 1
            continue
        camera = cameras_service.create_camera(conn, row)
        print(f"created id={camera['id']} stream_id={row['stream_id']} name={row['name']!r}")
        created += 1

    conn.close()
    print(f"\nDone: {created} created, {skipped} already present.")


if __name__ == "__main__":
    main()
