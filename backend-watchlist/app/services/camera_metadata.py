"""Temporary camera metadata for the vehicle-trace demo.

backend-watchlist has no direct ownership of camera records (those belong to
backend-registry's `cameras` table in Model 1), and the demo cameras
(101/102/103) aren't real registered cameras there — so rather than reaching
across into another service's schema/data for a one-off demo we hardcode the
three demo cameras here.

backend-registry has since grown a real `stream_id`/`hls_url` concept on its
`cameras` table (see contract/API_CONTRACT.md, Model 1) — once these demo
cameras are registered there for real, replace this with a lookup against
that table (same Postgres instance — see database.py) or a service call, and
delete this module.
"""

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


def lookup(camera_id: int) -> dict:
    """Returns camera metadata fields for a sighting, or all-None fields for
    an unknown camera_id (never raises — a missing lookup shouldn't hide a
    real detection from the trace)."""
    return DEMO_CAMERAS.get(
        camera_id,
        {"camera_name": None, "latitude": None, "longitude": None, "stream_id": None},
    )
