"""Seeds the 5 phone-camera feeds used for the vehicle-tracing demo: real,
temporary live streams published from Larix (on 5 separate phones) through
MediaMTX, tunneled to https://stream.digdhrishti.me -- a different domain
from this deployment's own MEDIAMTX_HLS_URL, so each camera's hls_url is set
to the fully-qualified playlist URL rather than relying on stream_id
resolution (see lib/stream.ts's resolveStreamUrl: hls_url always wins when
set). They're only actually reachable while their phone has Larix broadcasting
in the foreground and Tailscale connected -- connectivity_status/health_status
are left 'unknown' rather than guessed 'online', matching this repo's
convention of never asserting a status this script can't itself verify.

Grouped under a new "Phones" area in Anand district (the same village_id
convention already used for other areas, see scripts/seed_locations.py) so
they show up together in the District -> Area -> Camera tree, distinct from
the organizer's own direct-cam feeds.

Idempotent -- upserts each camera by stream_id, safe to re-run (e.g. if a
phone's tunnel URL is reissued before the demo)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.db import get_conn

DISTRICT = "Anand"
VILLAGE = "Anand"
AREA_NAME = "Phones"

# Anand city centre; each phone offset a few hundred metres apart so the 5
# pins don't sit exactly on top of one another on the map.
BASE_LAT, BASE_LONG = 22.5645, 72.9289
OFFSETS = [(0.0, 0.0), (0.003, 0.002), (-0.003, 0.002), (0.003, -0.002), (-0.003, -0.002)]

PHONES = [
    {"label": "Phone 1 (Dhruv)", "stream_id": "direct-phone-dhruv"},
    {"label": "Phone 2", "stream_id": "direct-phone-2"},
    {"label": "Phone 3", "stream_id": "direct-phone-3"},
    {"label": "Phone 4", "stream_id": "direct-phone-4"},
    {"label": "Phone 5", "stream_id": "direct-phone-5"},
]

HLS_BASE = "https://stream.digdhrishti.me/stream/{stream_id}/index.m3u8?cookieCheck=1"


def _village_id(cur) -> int:
    cur.execute(
        """
        SELECT v.id FROM villages v
        JOIN talukas t ON t.id = v.taluka_id
        JOIN districts d ON d.id = t.district_id
        WHERE d.name = %s AND v.name = %s
        """,
        (DISTRICT, VILLAGE),
    )
    row = cur.fetchone()
    if row is None:
        raise RuntimeError(
            f"village '{VILLAGE}' in district '{DISTRICT}' not found -- run scripts/seed_locations.py first"
        )
    return row[0]


def _area_id(cur, village_id: int) -> int:
    cur.execute("SELECT id FROM areas WHERE village_id = %s AND name = %s", (village_id, AREA_NAME))
    row = cur.fetchone()
    if row is not None:
        return row[0]
    cur.execute(
        "INSERT INTO areas (name, village_id) VALUES (%s, %s) RETURNING id",
        (AREA_NAME, village_id),
    )
    return cur.fetchone()[0]


def seed():
    with get_conn() as conn:
        with conn.cursor() as cur:
            village_id = _village_id(cur)
            area_id = _area_id(cur, village_id)

            for phone, (dlat, dlong) in zip(PHONES, OFFSETS):
                stream_id = phone["stream_id"]
                hls_url = HLS_BASE.format(stream_id=stream_id)
                lat, long = BASE_LAT + dlat, BASE_LONG + dlong

                cur.execute("SELECT id FROM cameras WHERE stream_id = %s", (stream_id,))
                existing = cur.fetchone()
                if existing is not None:
                    cur.execute(
                        """
                        UPDATE cameras
                        SET name = %(name)s, hls_url = %(hls_url)s, area_id = %(area_id)s,
                            location = ST_SetSRID(ST_MakePoint(%(long)s, %(lat)s), 4326)
                        WHERE stream_id = %(stream_id)s
                        """,
                        {"name": phone["label"], "hls_url": hls_url, "area_id": area_id,
                         "long": long, "lat": lat, "stream_id": stream_id},
                    )
                else:
                    cur.execute(
                        """
                        INSERT INTO cameras (
                            name, dept, location, camera_type, ownership,
                            connectivity_status, storage_type, retention_days,
                            health_status, stream_id, hls_url, area_id
                        )
                        VALUES (
                            %(name)s, 'Traffic Police',
                            ST_SetSRID(ST_MakePoint(%(long)s, %(lat)s), 4326),
                            'mobile_handheld', 'department', 'unknown', 'none', 0,
                            'unknown', %(stream_id)s, %(hls_url)s, %(area_id)s
                        )
                        """,
                        {"name": phone["label"], "long": long, "lat": lat,
                         "stream_id": stream_id, "hls_url": hls_url, "area_id": area_id},
                    )
        conn.commit()
    print(f"Seeded {len(PHONES)} phone demo cameras under '{AREA_NAME}' area ({DISTRICT} / {VILLAGE}).")


if __name__ == "__main__":
    seed()
