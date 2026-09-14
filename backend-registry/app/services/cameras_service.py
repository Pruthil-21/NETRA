"""Business logic for cameras — raw SQL via psycopg, no ORM."""
import asyncio
from datetime import datetime, timezone

import httpx

from ..config import settings
from ..db import get_conn
from ..logging_config import logger
from . import audit_service, stream_health_service


def _format_duration(seconds: float) -> str:
    """Plain-English "how long did the previous status hold" for a
    connectivity-transition audit entry's reason_code -- e.g. "3h 12m",
    "45m", "0m" for anything under a minute."""
    minutes = int(seconds // 60)
    if minutes < 60:
        return f"{minutes}m"
    hours, minutes = divmod(minutes, 60)
    if hours < 24:
        return f"{hours}h {minutes}m" if minutes else f"{hours}h"
    days, hours = divmod(hours, 24)
    return f"{days}d {hours}h" if hours else f"{days}d"


def list_cameras(conn, dept: str | None = None):
    with conn.cursor() as cur:
        if dept is None:
            cur.execute("""
                SELECT id, name, dept, ST_Y(location::geometry) AS lat,
                       ST_X(location::geometry) AS long, camera_type, ownership,
                       connectivity_status, storage_type, retention_days,
                       health_status, rtsp_url, stream_id, hls_url, area_id
                FROM cameras
                WHERE is_synthetic = false AND is_virtual_capture = false
                ORDER BY id
            """)
        else:
            cur.execute("""
                SELECT id, name, dept, ST_Y(location::geometry) AS lat,
                       ST_X(location::geometry) AS long, camera_type, ownership,
                       connectivity_status, storage_type, retention_days,
                       health_status, rtsp_url, stream_id, hls_url, area_id
                FROM cameras
                WHERE dept = %s AND is_synthetic = false AND is_virtual_capture = false
                ORDER BY id
            """, (dept,))
        cols = [c.name for c in cur.description]
        rows = cur.fetchall()
        return [dict(zip(cols, row)) for row in rows]


MAX_PAGE_LIMIT = 500

_CAMERA_COLUMNS = """id, name, dept, ST_Y(location::geometry) AS lat,
                     ST_X(location::geometry) AS long, camera_type, ownership,
                     connectivity_status, storage_type, retention_days,
                     health_status, rtsp_url, stream_id, hls_url, area_id,
                     is_synthetic, edge_node_id"""


def list_cameras_page(
    conn,
    cursor: int | None = None,
    limit: int = 100,
    include_synthetic: bool = False,
    dept: str | None = None,
    bbox: tuple[float, float, float, float] | None = None,
) -> dict:
    """Keyset-paginated camera listing. bbox is (min_lat, max_lat, min_long, max_long).
    limit is always capped server-side at MAX_PAGE_LIMIT, regardless of what's requested --
    this endpoint must never be able to return all 80,000+ rows in one response."""
    limit = min(limit, MAX_PAGE_LIMIT)
    clauses = []
    params: dict = {"limit": limit + 1}  # fetch one extra to know if there's a next page

    if include_synthetic:
        clauses.append("is_synthetic = true")
    else:
        clauses.append("is_synthetic = false")
        clauses.append("is_virtual_capture = false")
    if cursor is not None:
        clauses.append("id > %(cursor)s")
        params["cursor"] = cursor
    if dept is not None:
        clauses.append("dept = %(dept)s")
        params["dept"] = dept
    if bbox is not None:
        min_lat, max_lat, min_long, max_long = bbox
        clauses.append(
            "location && ST_MakeEnvelope(%(min_long)s, %(min_lat)s, %(max_long)s, %(max_lat)s, 4326)::geography"
        )
        params.update(min_lat=min_lat, max_lat=max_lat, min_long=min_long, max_long=max_long)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT {_CAMERA_COLUMNS} FROM cameras {where} ORDER BY id LIMIT %(limit)s",
            params,
        )
        cols = [c.name for c in cur.description]
        rows = [dict(zip(cols, row)) for row in cur.fetchall()]

    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        next_cursor = rows[-1]["id"]

    return {"cameras": rows, "next_cursor": next_cursor}


def get_camera(conn, camera_id: int):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, dept, ST_Y(location::geometry) AS lat,
                   ST_X(location::geometry) AS long, camera_type, ownership,
                   connectivity_status, storage_type, retention_days,
                   health_status, rtsp_url, stream_id, hls_url, area_id
            FROM cameras
            WHERE id = %s
        """, (camera_id,))
        row = cur.fetchone()
        if row is None:
            return None
        cols = [c.name for c in cur.description]
        return dict(zip(cols, row))


def get_camera_by_stream_id(conn, stream_id: str):
    """The recording service's webhook (routers/recording_webhooks.py) only
    knows the camera path it's ingesting from, not our registry's numeric
    id -- this resolves that path back to a real camera so an inbound event
    can be broadcast scoped to the right district."""
    with conn.cursor() as cur:
        cur.execute("SELECT id, name, dept FROM cameras WHERE stream_id = %s LIMIT 1", (str(stream_id),))
        row = cur.fetchone()
        if row is None:
            return None
        cols = [c.name for c in cur.description]
        return dict(zip(cols, row))


def create_camera(conn, data: dict):
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO cameras (
                name, dept, location, camera_type, ownership,
                connectivity_status, storage_type, retention_days,
                health_status, rtsp_url, stream_id, hls_url, area_id
            )
            VALUES (
                %(name)s, %(dept)s,
                ST_SetSRID(ST_MakePoint(%(long)s, %(lat)s), 4326),
                %(camera_type)s, %(ownership)s, %(connectivity_status)s,
                %(storage_type)s, %(retention_days)s, %(health_status)s,
                %(rtsp_url)s, %(stream_id)s, %(hls_url)s, %(area_id)s
            )
            RETURNING id
        """, {**data, "stream_id": data.get("stream_id"), "hls_url": data.get("hls_url"),
              "area_id": data.get("area_id")})
        new_id = cur.fetchone()[0]
        conn.commit()
    return get_camera(conn, new_id)


def update_camera(conn, camera_id: int, data: dict):
    """Returns (updated_camera, connectivity_changed: bool) -- the router
    uses connectivity_changed to decide whether it should ALSO write an
    audit_logs entry for a real, officer-driven field edit (name/area/etc);
    a connectivity transition gets its own audit_logs entry right here
    (action camera_online/camera_offline, actor "system" -- these are
    reported by the health-check poll, not performed by whichever officer's
    browser happens to be open, so attributing it to their badge would be
    misleading), in addition to the camera_status_history row every real
    transition has always written. reason_code carries how long the
    PREVIOUS status held (e.g. "was online for 3h 12m"), when there's a
    prior transition to measure that against."""
    fields = {k: v for k, v in data.items() if v is not None}
    if not fields:
        return get_camera(conn, camera_id), False

    connectivity_changed = False
    held_duration_text: str | None = None
    with conn.cursor() as cur:
        if "connectivity_status" in fields:
            cur.execute("SELECT connectivity_status FROM cameras WHERE id = %s", (camera_id,))
            row = cur.fetchone()
            if row is None:
                return None, False
            current_status = row[0]
            if fields["connectivity_status"] != current_status:
                connectivity_changed = True
                cur.execute(
                    "SELECT changed_at FROM camera_status_history WHERE camera_id = %s "
                    "ORDER BY changed_at DESC LIMIT 1",
                    (camera_id,),
                )
                prev = cur.fetchone()
                if prev is not None:
                    held_seconds = (datetime.now(timezone.utc) - prev[0]).total_seconds()
                    held_duration_text = f"was {current_status} for {_format_duration(held_seconds)}"

        set_clauses = [f"{key} = %({key})s" for key in fields if key not in ("lat", "long")]
        if "lat" in fields and "long" in fields:
            set_clauses.append("location = ST_SetSRID(ST_MakePoint(%(long)s, %(lat)s), 4326)")

        cur.execute(f"""
            UPDATE cameras SET {', '.join(set_clauses)}
            WHERE id = %(camera_id)s
            RETURNING id
        """, {**fields, "camera_id": camera_id})
        row = cur.fetchone()
        if row is None:
            conn.commit()
            return None, False

        if connectivity_changed:
            cur.execute(
                "INSERT INTO camera_status_history (camera_id, connectivity_status) VALUES (%s, %s)",
                (camera_id, fields["connectivity_status"]),
            )
        conn.commit()

    if connectivity_changed:
        new_status = fields["connectivity_status"]
        # connectivity_status isn't a strict online/offline enum server-side
        # (schema.sql defaults new cameras to "unknown") -- only the two
        # real states get their own action name; anything else (a manual
        # "unknown" reset, say) falls back to a generic one rather than
        # mislabeling it as "offline".
        if new_status == "online":
            action = "camera_online"
        elif new_status == "offline":
            action = "camera_offline"
        else:
            action = "camera_status_changed"
        audit_service.log(conn, "system", action, "camera", camera_id, reason_code=held_duration_text)

    return get_camera(conn, camera_id), connectivity_changed


def list_camera_status_history(
    conn,
    camera_id: int | None = None,
    district: str | None = None,
    date_from=None,
    date_to=None,
) -> list[dict]:
    """Flat, filterable read across every camera's status-history rows --
    for the Data Console export. get_uptime_windows (below) stays the
    per-camera windowed view an officer looking at one camera actually
    wants; this is the "give me every transition in this range" cut a
    report pulls from instead."""
    clauses = []
    params: list = []
    if camera_id is not None:
        clauses.append("h.camera_id = %s")
        params.append(camera_id)
    if district is not None:
        clauses.append("c.dept = %s")
        params.append(district)
    if date_from is not None:
        clauses.append("h.changed_at >= %s")
        params.append(date_from)
    if date_to is not None:
        clauses.append("h.changed_at <= %s")
        params.append(date_to)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT h.id, h.camera_id, c.name AS camera_name, c.dept AS district,
                   h.connectivity_status, h.changed_at
            FROM camera_status_history h
            JOIN cameras c ON c.id = h.camera_id
            {where}
            ORDER BY h.changed_at DESC
            """,
            params,
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_uptime_windows(conn, camera_id: int) -> list[dict] | None:
    """Pairs consecutive camera_status_history rows into windows: each row's
    status holds from its own changed_at until the next row's changed_at
    (or until now, for the most recent row -- that window is still open)."""
    camera = get_camera(conn, camera_id)
    if camera is None:
        return None

    with conn.cursor() as cur:
        cur.execute(
            "SELECT connectivity_status, changed_at FROM camera_status_history "
            "WHERE camera_id = %s ORDER BY changed_at",
            (camera_id,),
        )
        rows = cur.fetchall()

    windows = []
    now = datetime.now(timezone.utc)
    for i, (status, changed_at) in enumerate(rows):
        window_end = rows[i + 1][1] if i + 1 < len(rows) else None
        end_for_duration = window_end if window_end is not None else now
        windows.append({
            "status": status,
            "from": changed_at,
            "to": window_end,
            "duration_seconds": (end_for_duration - changed_at).total_seconds(),
        })
    return windows


def delete_camera(conn, camera_id: int) -> bool:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM cameras WHERE id = %s RETURNING id", (camera_id,))
        row = cur.fetchone()
        conn.commit()
        return row is not None


def get_summary(conn) -> dict:
    """One aggregate query against the indexes from Task 1 -- never fetches
    individual camera rows to count in Python, so this stays fast at 80,000+ rows."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE connectivity_status = 'online') AS online,
                COUNT(*) FILTER (WHERE connectivity_status = 'degraded') AS degraded,
                COUNT(*) FILTER (WHERE connectivity_status = 'offline') AS offline,
                COUNT(*) FILTER (WHERE is_synthetic = false) AS real_stream_count,
                COUNT(*) FILTER (WHERE is_synthetic = true) AS synthetic_count
            FROM cameras
        """)
        row = cur.fetchone()
        cur.execute("SELECT COUNT(*) FROM edge_nodes")
        edge_node_count = cur.fetchone()[0]

    return {
        "total": row[0],
        "online": row[1],
        "degraded": row[2],
        "offline": row[3],
        "real_stream_count": row[4],
        "synthetic_count": row[5],
        "edge_node_count": edge_node_count,
    }


def get_district_summary(conn, bbox: tuple[float, float, float, float] | None = None) -> list[dict]:
    """Real SQL GROUP BY district -- this is what the zoomed-out map view
    calls instead of counting a single truncated page of cameras client-side,
    which would under-report any district with more cameras than fit in one
    page. bbox is (min_lat, max_lat, min_long, max_long)."""
    # District summary is exclusively the scale-demo's zoomed-out map panel
    # (ScaleMap.tsx's "District Summary (Simulation)") -- it must only ever
    # reflect synthetic data, same as the per-camera markers it sits beside.
    clauses = ["is_synthetic = true"]
    params: dict = {}
    if bbox is not None:
        min_lat, max_lat, min_long, max_long = bbox
        clauses.append(
            "location && ST_MakeEnvelope(%(min_long)s, %(min_lat)s, %(max_long)s, %(max_lat)s, 4326)::geography"
        )
        params.update(min_lat=min_lat, max_lat=max_lat, min_long=min_long, max_long=max_long)
    where = f"WHERE {' AND '.join(clauses)}"

    with conn.cursor() as cur:
        cur.execute(
            f"SELECT dept AS district, COUNT(*) AS count FROM cameras {where} GROUP BY dept ORDER BY count DESC",
            params,
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def resolve_hls_url(hls_url: str | None, stream_id: str | None) -> str | None:
    """Same fallback routers/cameras.py's live-check/test-stream endpoints
    use, shared here so the periodic sweep below resolves a camera's
    checkable URL identically to those on-demand endpoints."""
    return hls_url or (f"{settings.mediamtx_hls_url}/stream/{stream_id}/index.m3u8" if stream_id else None)


# How many consecutive failed sweeps a camera must rack up before the badge
# actually flips to offline -- absorbs a single missed probe (a transient
# network blip, a MediaMTX restart) instead of flapping the sitewide badge
# on one bad tick, the same "require a run of consecutive failures" flap-
# avoidance convention real monitoring systems use (Nagios flap detection,
# Prometheus debounce windows). Recovery is intentionally NOT symmetric --
# a single successful probe clears the counter and flips back online right
# away, since a false "still offline" is worse for an officer than a false
# "back online" that a following check agrees or disagrees with a moment
# later anyway.
_OFFLINE_AFTER_CONSECUTIVE_FAILURES = 2
# Bounds concurrent sync DB writes (each update_camera call runs in its own
# thread via asyncio.to_thread) so a tick with many simultaneous real
# transitions -- e.g. the very first sweep after deploy, when every camera
# is still at its seeded/default status -- can't check out more connections
# at once than is reasonable against the shared pool (db.py's
# DB_POOL_MAX_SIZE), independent of the much larger HTTP-probe concurrency.
_DB_WRITE_CONCURRENCY = 10

# Per-camera run of consecutive failed probes, in-process only -- resets on
# restart (one extra debounce cycle after a redeploy, an acceptable cost for
# not needing a dedicated DB column/table just for this counter).
_consecutive_failures: dict[int, int] = {}


async def _probe_camera(client: httpx.AsyncClient, http_sem: asyncio.Semaphore, camera: dict) -> tuple[int, bool]:
    url = resolve_hls_url(camera["hls_url"], camera["stream_id"])
    if url is None:
        # Nothing configured to check -- not a transient failure, this
        # camera can never be "online" until it has a real stream endpoint.
        return camera["id"], False
    async with http_sem:
        reachable = await stream_health_service.check_hls_reachable(client, url)
    return camera["id"], reachable


def _write_transition(camera_id: int, new_status: str) -> None:
    with get_conn() as conn:
        update_camera(conn, camera_id, {"connectivity_status": new_status})


async def _apply_probe_results(results: list[tuple[int, bool]], current_by_id: dict[int, str]) -> None:
    write_sem = asyncio.Semaphore(_DB_WRITE_CONCURRENCY)

    async def maybe_write(camera_id: int, reachable: bool) -> None:
        current_status = current_by_id.get(camera_id)
        if reachable:
            _consecutive_failures.pop(camera_id, None)
            if current_status != "online":
                async with write_sem:
                    await asyncio.to_thread(_write_transition, camera_id, "online")
            return

        failures = _consecutive_failures.get(camera_id, 0) + 1
        _consecutive_failures[camera_id] = failures
        if failures >= _OFFLINE_AFTER_CONSECUTIVE_FAILURES and current_status != "offline":
            async with write_sem:
                await asyncio.to_thread(_write_transition, camera_id, "offline")

    await asyncio.gather(*(maybe_write(camera_id, reachable) for camera_id, reachable in results))


async def sweep_connectivity_once() -> None:
    """One full pass over every real (non-synthetic, non-virtual-capture)
    camera -- pages MAX_PAGE_LIMIT at a time so memory and in-flight work
    stay bounded regardless of fleet size, and probes each page's cameras
    concurrently under settings.camera_health_concurrency. This is the ONE
    server-owned writer of cameras.connectivity_status now -- frontend
    clients only ever read it, never probe streams themselves (see
    CameraRegistryContext.tsx / useCameraFeeds.ts, which used to run this
    exact kind of check from every open browser tab, independently,
    disagreeing with each other and with this sweep -- the root cause this
    sweep exists to fix)."""
    http_sem = asyncio.Semaphore(settings.camera_health_concurrency)
    cursor: int | None = None

    async with httpx.AsyncClient() as client:
        while True:
            def fetch_page(c=cursor):
                with get_conn() as conn:
                    return list_cameras_page(conn, cursor=c, limit=MAX_PAGE_LIMIT, include_synthetic=False)

            page = await asyncio.to_thread(fetch_page)
            cameras = page["cameras"]
            if not cameras:
                break

            current_by_id = {cam["id"]: cam["connectivity_status"] for cam in cameras}
            results = await asyncio.gather(*(_probe_camera(client, http_sem, cam) for cam in cameras))
            await _apply_probe_results(results, current_by_id)

            cursor = page["next_cursor"]
            if cursor is None:
                break


async def run_periodic_connectivity_sweep() -> None:
    """Background task, one sweep every settings.camera_health_sweep_interval_seconds
    -- started from main.py's startup event, cancelled on shutdown (same
    shape backend-watchlist uses for its own periodic loops). One failed
    tick is logged and skipped rather than killing the loop -- the next
    sweep catches up on whatever this one missed."""
    while True:
        try:
            await sweep_connectivity_once()
        except Exception:  # noqa: BLE001 -- one bad tick must not kill the loop; see docstring
            logger.exception("camera connectivity sweep tick failed")
        await asyncio.sleep(settings.camera_health_sweep_interval_seconds)
