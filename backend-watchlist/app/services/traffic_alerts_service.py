"""Business logic for congestion alerts -- density/flow threshold breaches,
computed from the same live-window queries the Map layers use
(detections_service.camera_density_counts/camera_flow_pairs), not a
plate-match model. See schema.sql's traffic_alerts table for why this is a
separate table from watchlist-match `alerts`: no append-only status-history
chain-of-custody requirement here, so a single status column with
acknowledged_by/at is enough.

evaluate_and_broadcast is the one entry point the periodic background task
(run_periodic_evaluation, started from main.py's startup event) calls every
config.settings.traffic_alert_eval_interval_seconds; it's also directly
callable from a test to force one evaluation tick without waiting on the
real interval.
"""
import asyncio

from psycopg2.extras import RealDictCursor

from .. import database
from ..config import settings
from ..logging_config import logger
from . import alerts_stream, detections_service


def _camera_district(db: RealDictCursor, camera_id: int) -> str | None:
    db.execute("SELECT dept FROM cameras WHERE id = %s", (camera_id,))
    row = db.fetchone()
    return row["dept"] if row else None


def _has_open_alert(
    db: RealDictCursor, alert_type: str, camera_id: int | None = None,
    from_camera_id: int | None = None, to_camera_id: int | None = None,
) -> bool:
    """True if a NEW/ACKNOWLEDGED alert for this exact camera (density) or
    corridor (flow) already exists within the cooldown window -- otherwise
    every evaluation tick during a sustained jam would create a fresh row
    instead of leaving the existing one for an officer to act on."""
    clauses = [
        "alert_type = %s", "status IN ('NEW', 'ACKNOWLEDGED')",
        "triggered_at >= now() - (%s || ' minutes')::interval",
    ]
    params: list = [alert_type, settings.traffic_alert_cooldown_minutes]
    if camera_id is not None:
        clauses.append("camera_id = %s")
        params.append(camera_id)
    else:
        clauses += ["from_camera_id = %s", "to_camera_id = %s"]
        params += [from_camera_id, to_camera_id]
    db.execute(f"SELECT 1 FROM traffic_alerts WHERE {' AND '.join(clauses)} LIMIT 1", params)
    return db.fetchone() is not None


def _create_and_broadcast(
    db: RealDictCursor, alert_type: str, metric_value: float, threshold_value: float,
    district: str | None, camera_id: int | None = None,
    from_camera_id: int | None = None, to_camera_id: int | None = None,
) -> dict:
    db.execute(
        """
        INSERT INTO traffic_alerts
            (alert_type, camera_id, from_camera_id, to_camera_id, metric_value, threshold_value, district)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        RETURNING *
        """,
        (alert_type, camera_id, from_camera_id, to_camera_id, metric_value, threshold_value, district),
    )
    alert = db.fetchone()
    alerts_stream.manager.broadcast_sync(alert, district, kind="congestion")

    return alert


def evaluate_and_broadcast(db: RealDictCursor) -> list[dict]:
    """One evaluation tick, network-wide (not district-scoped -- this is a
    system process, not a request on behalf of one officer): pulls the
    current live-window density/flow readings and creates+broadcasts a
    traffic_alerts row for every breach not already on cooldown. Returns
    the newly created alerts (empty when nothing breached, or everything
    that did was already covered by an existing open alert)."""
    created = []

    density = detections_service.camera_density_counts(db, window_minutes=settings.traffic_alert_window_minutes)
    for row in density:
        if row["count"] < settings.traffic_density_alert_threshold:
            continue
        if _has_open_alert(db, "density", camera_id=row["camera_id"]):
            continue
        district = _camera_district(db, row["camera_id"])
        created.append(_create_and_broadcast(
            db, "density", row["count"], settings.traffic_density_alert_threshold, district,
            camera_id=row["camera_id"],
        ))

    flows = detections_service.camera_flow_pairs(db, window_minutes=settings.traffic_alert_window_minutes)
    for row in flows:
        if row["avg_speed_kmh"] is None or row["avg_speed_kmh"] > settings.traffic_flow_congestion_speed_kmh:
            continue
        if _has_open_alert(db, "flow", from_camera_id=row["from_camera_id"], to_camera_id=row["to_camera_id"]):
            continue
        district = _camera_district(db, row["from_camera_id"])
        created.append(_create_and_broadcast(
            db, "flow", row["avg_speed_kmh"], settings.traffic_flow_congestion_speed_kmh, district,
            from_camera_id=row["from_camera_id"], to_camera_id=row["to_camera_id"],
        ))

    return created


def list_traffic_alerts(
    db: RealDictCursor, status: str | None = None, alert_type: str | None = None, district: str | None = None,
):
    clauses = []
    params: list = []
    if status is not None:
        clauses.append("status = %s")
        params.append(status)
    if alert_type is not None:
        clauses.append("alert_type = %s")
        params.append(alert_type)
    if district is not None:
        clauses.append("district = %s")
        params.append(district)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    db.execute(f"SELECT * FROM traffic_alerts {where} ORDER BY triggered_at DESC", params)
    return db.fetchall()


def update_status(db: RealDictCursor, alert_id: int, status: str, changed_by: str):
    db.execute("SELECT id FROM traffic_alerts WHERE id = %s", (alert_id,))
    if db.fetchone() is None:
        return None

    if status == "ACKNOWLEDGED":
        db.execute(
            """
            UPDATE traffic_alerts SET status = %s, acknowledged_by = %s, acknowledged_at = now()
            WHERE id = %s RETURNING *
            """,
            (status, changed_by, alert_id),
        )
    else:
        db.execute("UPDATE traffic_alerts SET status = %s WHERE id = %s RETURNING *", (status, alert_id))
    return db.fetchone()


def _run_evaluation_tick() -> list[dict]:
    """Sync entry point for one tick, used both by the background loop
    below (via asyncio.to_thread) and directly by tests -- opens its own
    connection rather than depending on a request-scoped `get_db()`, since
    this runs outside any request."""
    with database.get_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cursor:
            return evaluate_and_broadcast(cursor)


async def run_periodic_evaluation():
    """Background task, one iteration every
    settings.traffic_alert_eval_interval_seconds -- started from main.py's
    startup event, cancelled on shutdown. Runs the actual DB work in a
    thread since psycopg2 is sync: without that, each tick would block the
    whole event loop -- every in-flight request, and the alerts WS -- for
    as long as the density/flow queries take. A single failed tick (e.g. a
    transient DB error) is logged and skipped rather than killing the loop,
    since the next tick 5 minutes later will simply re-evaluate the same
    current state."""
    while True:
        try:
            await asyncio.to_thread(_run_evaluation_tick)
        except Exception:  # noqa: BLE001 -- one bad tick must not kill the loop; see docstring
            logger.exception("congestion-alert evaluation tick failed")
        await asyncio.sleep(settings.traffic_alert_eval_interval_seconds)
