"""Business logic for alerts — matches incoming ANPR detections against the watchlist."""
from psycopg2.extras import RealDictCursor

from ..schemas import DetectionIn
from . import watchlist_service


def list_alerts(db: RealDictCursor):
    db.execute("SELECT * FROM alerts ORDER BY matched_at DESC")
    return db.fetchall()


def process_detection(db: RealDictCursor, detection: DetectionIn):
    """Checks a plate against the watchlist; creates an alert if it matches."""
    match = watchlist_service.find_by_plate(db, detection.plate_number)
    if not match:
        return None

    db.execute(
        """
        INSERT INTO alerts (camera_id, plate_number, watchlist_id, status)
        VALUES (%s, %s, %s, 'NEW')
        RETURNING *
        """,
        (detection.camera_id, detection.plate_number, match["id"]),
    )
    return db.fetchone()


def update_status(db: RealDictCursor, alert_id: int, status: str):
    db.execute(
        "UPDATE alerts SET status = %s WHERE id = %s RETURNING *",
        (status, alert_id),
    )
    return db.fetchone()
