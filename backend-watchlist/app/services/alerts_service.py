"""Business logic for alerts — matches incoming ANPR detections against the watchlist.

alerts rows are never UPDATEd after creation (evidentiary chain-of-custody).
Status transitions are appended to alert_status_history; every read here joins
in the latest history row so callers always see the current status.
"""
from psycopg2.extras import RealDictCursor

from . import govt_lookup_service, watchlist_service

_SELECT_WITH_CURRENT_STATUS = """
    SELECT a.id, a.camera_id, a.plate_number, a.watchlist_id, a.detection_id,
           a.matched_at, COALESCE(h.status, a.status) AS status
    FROM alerts a
    LEFT JOIN LATERAL (
        SELECT status FROM alert_status_history
        WHERE alert_id = a.id
        ORDER BY changed_at DESC, id DESC
        LIMIT 1
    ) h ON true
"""


def _with_owner_details(alert):
    if alert is not None:
        # Combined VAHAN (ownership) + eGujCop (crime/FIR) lookup, both
        # keyed on the alert's plate_number -- see govt_lookup_service.py.
        alert["owner_details"] = govt_lookup_service.lookup_vehicle(alert["plate_number"])
    return alert


def _with_nearest_station(db, alert):
    if alert is not None:
        # police_stations is owned by backend-registry but lives in the
        # same physical Postgres instance (same convention as cameras.dept
        # lookups elsewhere in this codebase).
        db.execute(
            """
            SELECT nearest.name, nearest.distance_meters
            FROM cameras c
            LEFT JOIN LATERAL (
                SELECT ps.name, ST_Distance(c.location, ps.location) AS distance_meters
                FROM police_stations ps
                ORDER BY c.location <-> ps.location
                LIMIT 1
            ) nearest ON true
            WHERE c.id = %s
            """,
            (alert["camera_id"],),
        )
        row = db.fetchone()
        alert["nearest_station"] = (
            {"name": row["name"], "distance_meters": row["distance_meters"]}
            if row is not None and row["name"] is not None
            else None
        )
    return alert


def list_alerts(db: RealDictCursor):
    db.execute(_SELECT_WITH_CURRENT_STATUS + " ORDER BY a.matched_at DESC")
    alerts = db.fetchall()
    for alert in alerts:
        _with_owner_details(alert)
        _with_nearest_station(db, alert)
    return alerts


def get_alert(db: RealDictCursor, alert_id: int):
    db.execute(_SELECT_WITH_CURRENT_STATUS + " WHERE a.id = %s", (alert_id,))
    return _with_nearest_station(db, _with_owner_details(db.fetchone()))


def get_alert_by_detection_id(db: RealDictCursor, detection_id: int):
    """Looks up the alert (if any) already linked to a detection — used when
    POST /detections receives a retry (a duplicate event_id/scenario_run_id)
    so the original alert can be returned instead of calling
    process_detection again and creating a second one for the same
    underlying sighting."""
    db.execute(_SELECT_WITH_CURRENT_STATUS + " WHERE a.detection_id = %s", (detection_id,))
    return _with_nearest_station(db, _with_owner_details(db.fetchone()))


def process_detection(db: RealDictCursor, camera_id: int, plate_number: str, detection_id: int):
    """Checks a plate against the watchlist; creates an alert (linked back to
    the detections row that triggered it) if it matches. Called as a side
    effect of POST /detections — a match is a detection too."""
    match = watchlist_service.find_by_plate(db, plate_number)
    if not match:
        return None

    db.execute(
        """
        INSERT INTO alerts (camera_id, plate_number, watchlist_id, detection_id, status)
        VALUES (%s, %s, %s, %s, 'NEW')
        RETURNING id
        """,
        (camera_id, plate_number, match["id"], detection_id),
    )
    new_id = db.fetchone()["id"]
    return get_alert(db, new_id)


def has_prior_status_change(db, alert_id: int, changed_by) -> bool:
    """True if `changed_by` already has a status-history row on this alert --
    used to enforce Separation of Duty on escalation (spec Section 6): the
    officer who first acted on an alert can't also be the one who escalates it."""
    db.execute(
        "SELECT 1 FROM alert_status_history WHERE alert_id = %s AND changed_by = %s LIMIT 1",
        (alert_id, changed_by),
    )
    return db.fetchone() is not None


def update_status(db: RealDictCursor, alert_id: int, status: str, changed_by):
    db.execute("SELECT id FROM alerts WHERE id = %s", (alert_id,))
    if db.fetchone() is None:
        return None

    db.execute(
        """
        INSERT INTO alert_status_history (alert_id, status, changed_by)
        VALUES (%s, %s, %s)
        """,
        (alert_id, status, changed_by),
    )
    return get_alert(db, alert_id)
