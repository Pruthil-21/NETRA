"""Temporary camera metadata for the vehicle-trace demo.

backend-watchlist has no direct ownership of camera records (those belong to
backend-registry's `cameras` table in Model 1) and that table has no
`stream_id` concept at all, so rather than reaching across into another
service's schema for a one-off demo we hardcode the three demo cameras here.

This is explicitly temporary: once the vehicle-trace feature needs real
(non-demo) cameras, replace this with a lookup against backend-registry's
`cameras` table (same Postgres instance — see database.py) or a service call,
and delete this module.
"""

DEMO_CAMERAS: dict[int, dict] = {
    101: {
        "camera_name": "Petlad Entry Checkpoint",
        "latitude": 22.4729,
        "longitude": 72.7938,
        "stream_id": "101",
    },
    102: {
        "camera_name": "Petlad Town Centre",
        "latitude": 22.4766,
        "longitude": 72.7994,
        "stream_id": "102",
    },
    103: {
        "camera_name": "Petlad Exit Checkpoint",
        "latitude": 22.4804,
        "longitude": 72.8051,
        "stream_id": "103",
    },
}


def lookup(camera_id: int) -> dict:
    """Returns camera metadata fields for a sighting, or all-None fields for
    an unknown camera_id (never raises — a missing lookup shouldn't hide a
    real detection from the trace)."""
    return DEMO_CAMERAS.get(
        camera_id,
        {"camera_name": None, "latitude": None, "longitude": None, "stream_id": None},
    )
