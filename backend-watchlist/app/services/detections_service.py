"""Business logic for ANPR detections — the permanent, insert-only sighting
history. Every plate read is recorded here regardless of watchlist status;
a match additionally gets an alerts row (see alerts_service.process_detection).
"""
from psycopg2.extras import RealDictCursor

from ..schemas import DetectionIn, normalize_plate
from . import camera_metadata


def record_detection(db: RealDictCursor, detection: DetectionIn):
    """Inserts one detection. plate_number arrives already normalized (see
    schemas.DetectionIn's validator) so `GX15 OGJ` and `GX15OGJ` land as the
    same value here and below.

    When scenario_run_id is set (a scripted/replayed source, e.g. the
    vehicle-trace demo clip) this is idempotent per (scenario_run_id,
    camera_id, plate_number): a repeat POST for a combination already seen
    — the looping clip re-detecting the same plate at the same camera — is a
    no-op that returns the existing row instead of inserting a duplicate.
    Nothing is ever updated or deleted, so the append-only evidentiary
    history is unaffected; a fresh scenario_run_id (a new replay run) is
    simply a new set of rows.

    Live ml-anpr detections (scenario_run_id None) are never deduped and
    insert exactly as before.
    """
    if detection.scenario_run_id is not None:
        db.execute(
            """
            INSERT INTO detections
                (plate_number, camera_id, confidence, detected_at, scenario_run_id, source)
            VALUES (%s, %s, %s, COALESCE(%s, now()), %s, %s)
            ON CONFLICT (scenario_run_id, camera_id, plate_number)
                WHERE scenario_run_id IS NOT NULL
                DO NOTHING
            RETURNING *
            """,
            (
                detection.plate_number,
                detection.camera_id,
                detection.confidence,
                detection.detected_at,
                detection.scenario_run_id,
                detection.source,
            ),
        )
        row = db.fetchone()
        if row is not None:
            return row

        # Suppressed duplicate — return the sighting already on record for
        # this run/camera/plate instead of inserting another one.
        db.execute(
            """
            SELECT * FROM detections
            WHERE scenario_run_id = %s AND camera_id = %s AND plate_number = %s
            """,
            (detection.scenario_run_id, detection.camera_id, detection.plate_number),
        )
        return db.fetchone()

    db.execute(
        """
        INSERT INTO detections (plate_number, camera_id, confidence, detected_at, source)
        VALUES (%s, %s, %s, COALESCE(%s, now()), %s)
        RETURNING *
        """,
        (
            detection.plate_number,
            detection.camera_id,
            detection.confidence,
            detection.detected_at,
            detection.source,
        ),
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
        params.append(normalize_plate(plate_number))
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


def get_vehicle_trace(
    db: RealDictCursor,
    plate_number: str,
    scenario_run_id: str | None = None,
):
    """Sightings for one plate, ordered oldest-first for a route/timeline
    view, each enriched with camera metadata (see camera_metadata.py — demo
    cameras only for now). scenario_run_id narrows to one replay run;
    omitted, it returns every sighting for the plate across all runs and
    live detections alike."""
    clauses = ["plate_number = %s"]
    params: list = [normalize_plate(plate_number)]
    if scenario_run_id is not None:
        clauses.append("scenario_run_id = %s")
        params.append(scenario_run_id)

    db.execute(
        f"SELECT * FROM detections WHERE {' AND '.join(clauses)} ORDER BY detected_at ASC",
        params,
    )
    sightings = db.fetchall()
    for sighting in sightings:
        sighting.update(camera_metadata.lookup(sighting["camera_id"]))
    return sightings
