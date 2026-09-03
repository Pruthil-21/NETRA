"""Business logic for ANPR detections — the permanent, insert-only sighting
history. Every plate read is recorded here regardless of watchlist status;
a match additionally gets an alerts row (see alerts_service.process_detection).

Every recorded detection also appends its exact timestamp to a derived
daily-rollup row in vehicle_daily_sightings, keyed on
(camera_id, plate_number, IST calendar day) -- see _upsert_daily_sighting.
That table is non-evidentiary and never replaces the detections history
above; it exists purely to answer "where was this plate seen today"
without scanning detections by hand.
"""
from datetime import datetime

from psycopg2.extras import RealDictCursor

from ..schemas import DetectionIn


def _upsert_daily_sighting(
    db: RealDictCursor, camera_id: int, plate_number: str, detected_at: datetime
) -> None:
    db.execute(
        """
        INSERT INTO vehicle_daily_sightings
            (camera_id, plate_number, sighting_date, detection_times)
        VALUES
            (%s, %s, (%s::timestamptz AT TIME ZONE 'Asia/Kolkata')::date, ARRAY[%s::timestamptz])
        ON CONFLICT (camera_id, plate_number, sighting_date)
        DO UPDATE SET detection_times =
            vehicle_daily_sightings.detection_times || EXCLUDED.detection_times
        """,
        (camera_id, plate_number, detected_at, detected_at),
    )


def record_detection(db: RealDictCursor, detection: DetectionIn):
    db.execute(
        """
        INSERT INTO detections (plate_number, camera_id, confidence)
        VALUES (%s, %s, %s)
        RETURNING *
        """,
        (detection.plate_number, detection.camera_id, detection.confidence),
    )
    row = db.fetchone()
    _upsert_daily_sighting(db, row["camera_id"], row["plate_number"], row["detected_at"])
    return row


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
