"""Road-following route geometry for the Map page's Flow layer corridors.

Without this, a corridor is a straight line between two camera lat/longs --
cuts through buildings, parks, water, cemeteries, with no regard for the
actual road network. Uses OSRM (Open Source Routing Machine) -- Contraction
Hierarchies/Multi-Level Dijkstra over OpenStreetMap data, the reference
open-source routing engine (project-osrm.org) -- against its public demo
server, which is fine for this project's non-commercial prototype use per
its usage policy (github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy):
best-effort, no guarantees, capped at 1 req/sec.

Given that cap, every camera pair's route is fetched from OSRM at most ONCE,
ever -- see get_or_fetch_route's cache-first check against
flow_route_cache -- since two fixed points' shortest road path doesn't
change over this project's lifetime. That keeps real OSRM call volume far
under the policy regardless of how many officers view the layer.
"""
import json
import os
import urllib.error
import urllib.request

from ..logging_config import logger

OSRM_BASE_URL = "https://router.project-osrm.org/route/v1/driving"
_REQUEST_TIMEOUT_SECONDS = 5


def _fetch_route(from_lat: float, from_long: float, to_lat: float, to_long: float) -> dict | None:
    """Returns {"geometry": [[lat, lon], ...], "distance_meters", "duration_seconds"}
    or None on any failure -- a routing hiccup degrades the corridor to "no
    route" (the frontend falls back to a straight line), it must never
    break the endpoint calling this.

    Skips the network call entirely under pytest -- same guard this session
    already uses for the traffic-alert background loop (see main.py) --
    without it, every test that creates a flow pair would make a real
    external HTTP call: slow, flaky, and disrespectful of OSRM's rate limit
    across a full test run.
    """
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return None

    url = f"{OSRM_BASE_URL}/{from_long},{from_lat};{to_long},{to_lat}?overview=full&geometries=geojson"
    try:
        with urllib.request.urlopen(url, timeout=_REQUEST_TIMEOUT_SECONDS) as resp:
            data = json.loads(resp.read())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        logger.warning(f"OSRM route fetch failed for ({from_lat},{from_long}) -> ({to_lat},{to_long})")
        return None

    if data.get("code") != "Ok" or not data.get("routes"):
        return None

    route = data["routes"][0]
    # OSRM returns [lon, lat] pairs -- flip to [lat, lon], the order every
    # other lat/long pair in this codebase (and Leaflet) already uses.
    geometry = [[lat, lon] for lon, lat in route["geometry"]["coordinates"]]
    return {
        "geometry": geometry,
        "distance_meters": route["distance"],
        "duration_seconds": route["duration"],
    }


def get_or_fetch_route(
    db, from_camera_id: int, to_camera_id: int,
    from_lat: float, from_long: float, to_lat: float, to_long: float,
) -> list[list[float]] | None:
    """`db` is the request-scoped RealDictCursor every other function in
    this module's caller (detections_service.py) already receives, not a
    connection -- no explicit commit here, the surrounding request's
    get_connection() wrapper commits everything once the route handler
    returns (same convention alerts_service.process_detection's INSERT
    already follows)."""
    db.execute(
        "SELECT geometry FROM flow_route_cache WHERE from_camera_id = %s AND to_camera_id = %s",
        (from_camera_id, to_camera_id),
    )
    row = db.fetchone()
    if row is not None:
        geometry = row["geometry"]
        return geometry if isinstance(geometry, list) else json.loads(geometry)

    result = _fetch_route(from_lat, from_long, to_lat, to_long)
    if result is None:
        return None

    db.execute(
        """
        INSERT INTO flow_route_cache
            (from_camera_id, to_camera_id, geometry, distance_meters, duration_seconds)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (from_camera_id, to_camera_id) DO NOTHING
        """,
        (from_camera_id, to_camera_id, json.dumps(result["geometry"]),
         result["distance_meters"], result["duration_seconds"]),
    )
    return result["geometry"]
