"""Business logic for ANPR detections — the permanent, insert-only sighting
history. Every plate read is recorded here regardless of watchlist status;
a match additionally gets an alerts row (see alerts_service.process_detection).
"""
from psycopg2.extras import RealDictCursor

from ..schemas import DetectionIn


def record_detection(db: RealDictCursor, detection: DetectionIn):
    db.execute(
        """
        INSERT INTO detections (plate_number, camera_id, confidence)
        VALUES (%s, %s, %s)
        RETURNING *
        """,
        (detection.plate_number, detection.camera_id, detection.confidence),
    )
    return db.fetchone()


def search_detections(
    db: RealDictCursor,
    plate_number: str | None = None,
    camera_id: int | None = None,
    date_from=None,
    date_to=None,
):
    clauses = []
    params = []
    if plate_number:
        clauses.append("plate_number = %s")
        params.append(plate_number)
    if camera_id is not None:
        clauses.append("camera_id = %s")
        params.append(camera_id)
    if date_from is not None:
        clauses.append("detected_at >= %s")
        params.append(date_from)
    if date_to is not None:
        clauses.append("detected_at <= %s")
        params.append(date_to)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    db.execute(f"SELECT * FROM detections {where} ORDER BY detected_at ASC", params)
    return db.fetchall()
