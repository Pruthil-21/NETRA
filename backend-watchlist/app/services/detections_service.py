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

from ..schemas import DetectionIn, normalize_plate
from . import camera_metadata, geo


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
    """Inserts one detection. plate_number arrives already normalized (see
    schemas.DetectionIn's validator) so `GX15 OGJ` and `GX15OGJ` land as the
    same value here and below.

    Returns (row, is_duplicate). is_duplicate is True only when a dedup
    mechanism suppressed a genuine insert and returned a pre-existing row
    instead — the caller (the POST /detections route) uses this to decide
    whether to run watchlist-match/alert processing again: a duplicate must
    return the ORIGINAL alert, not create a second one for the same
    underlying sighting.

    event_id (a client-supplied retry idempotency key) takes priority when
    both it and scenario_run_id are set, though in practice a caller sends
    at most one: a repeat POST with the same event_id — the same real-world
    detection resent because the client didn't know whether the first
    attempt landed — is a no-op that returns the existing row.

    Otherwise, when scenario_run_id is set (a scripted/replayed source, e.g.
    the vehicle-trace demo clip) this is idempotent per (scenario_run_id,
    camera_id, plate_number): a repeat POST for a combination already seen
    — the looping clip re-detecting the same plate at the same camera — is a
    no-op that returns the existing row instead of inserting a duplicate.

    Both mechanisms are additive only: nothing is ever updated or deleted,
    so the append-only evidentiary history is unaffected.

    Live ml-anpr detections that supply neither (the default, unaffected
    case) are never deduped and insert exactly as before.
    """
    if detection.event_id is not None:
        db.execute(
            """
            INSERT INTO detections
                (plate_number, camera_id, confidence, detected_at, scenario_run_id, source, event_id)
            VALUES (%s, %s, %s, COALESCE(%s, now()), %s, %s, %s)
            ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO NOTHING
            RETURNING *
            """,
            (
                detection.plate_number,
                detection.camera_id,
                detection.confidence,
                detection.detected_at,
                detection.scenario_run_id,
                detection.source,
                str(detection.event_id),
            ),
        )
        row = db.fetchone()
        if row is not None:
            _upsert_daily_sighting(db, row["camera_id"], row["plate_number"], row["detected_at"])
            return row, False

        # Suppressed duplicate — a retried POST for an event_id already on
        # record. Return the original sighting instead of inserting another.
        db.execute("SELECT * FROM detections WHERE event_id = %s", (str(detection.event_id),))
        return db.fetchone(), True

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
            _upsert_daily_sighting(db, row["camera_id"], row["plate_number"], row["detected_at"])
            return row, False

        # Suppressed duplicate — return the sighting already on record for
        # this run/camera/plate instead of inserting another one.
        db.execute(
            """
            SELECT * FROM detections
            WHERE scenario_run_id = %s AND camera_id = %s AND plate_number = %s
            """,
            (detection.scenario_run_id, detection.camera_id, detection.plate_number),
        )
        return db.fetchone(), True

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
    row = db.fetchone()
    _upsert_daily_sighting(db, row["camera_id"], row["plate_number"], row["detected_at"])
    return row, False


def search_detections(
    db: RealDictCursor,
    plate_number: str | None = None,
    camera_id: int | None = None,
    date_from=None,
    date_to=None,
    dept: str | None = None,
):
    clauses = []
    params = []
    joins = ""
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
    if dept is not None:
        # cameras is owned by backend-registry but lives in the same
        # physical Postgres instance (same convention as audit_logs).
        joins = "JOIN cameras c ON c.id = detections.camera_id"
        clauses.append("c.dept = %s")
        params.append(dept)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    select_cols = "detections.*" if joins else "*"
    db.execute(
        f"SELECT {select_cols} FROM detections {joins} {where} ORDER BY detected_at ASC",
        params,
    )
    return db.fetchall()


def _time_window_clauses(window_minutes: int | None, hour: int | None, on_date) -> tuple[list[str], list]:
    """The live-vs-hour window filter shared by every Map-layer analytics
    query below -- exactly one of the two, chosen by the caller (see the
    router's own validation that exactly one is set):

    - window_minutes: a rolling "right now" window (e.g. the last 30
      minutes).
    - hour + on_date: every detection whose IST calendar hour matches
      `hour` on `on_date`, for the time-of-day playback scrubber -- reusing
      the same append-only `detections` history rather than a separate
      hourly rollup, since an hour-bucketed scan is cheap enough at this
      table's current scale and the index above keeps it cheap as it grows.
    """
    if window_minutes is not None:
        return ["detected_at >= now() - (%s || ' minutes')::interval"], [window_minutes]
    return (
        [
            "(detected_at AT TIME ZONE 'Asia/Kolkata')::date = %s",
            "EXTRACT(HOUR FROM detected_at AT TIME ZONE 'Asia/Kolkata') = %s",
        ],
        [on_date, hour],
    )


def camera_density_counts(
    db: RealDictCursor,
    window_minutes: int | None = None,
    hour: int | None = None,
    on_date=None,
    dept: str | None = None,
):
    """Per-camera detection counts for the Map page's density layer.
    Cameras with zero detections in the window are simply absent from the
    result -- the frontend only paints where there's actual activity, so an
    idle camera contributing nothing here isn't a special case."""
    joins = ""
    clauses, params = _time_window_clauses(window_minutes, hour, on_date)

    if dept is not None:
        joins = "JOIN cameras c ON c.id = detections.camera_id"
        clauses.append("c.dept = %s")
        params.append(dept)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    db.execute(
        f"""
        SELECT detections.camera_id AS camera_id, COUNT(*) AS count
        FROM detections {joins}
        {where}
        GROUP BY detections.camera_id
        """,
        params,
    )
    return db.fetchall()


# A "transition" pairs a plate's two consecutive sightings network-wide (see
# predict_next_camera above for the same LEAD-window pattern) -- capped to
# this gap so a plate that vanishes for hours before resurfacing elsewhere
# doesn't get counted as a same-trip corridor between two otherwise
# unrelated visits.
MAX_FLOW_TRANSITION_GAP_HOURS = 3


def camera_flow_pairs(
    db: RealDictCursor,
    window_minutes: int | None = None,
    hour: int | None = None,
    on_date=None,
    dept: str | None = None,
    limit: int = 200,
):
    """Camera-to-camera transition volume and average travel speed for the
    Map page's Flow layer, within the same live/hour window
    camera_density_counts uses. Every plate's two consecutive sightings in
    the window count as one transition from the first camera to the
    second; grouped by (from, to) pair, this is a network-wide flow matrix,
    not any one vehicle's route.

    Average speed is computed here, not in SQL: it needs each camera's
    real lat/long (backend-registry's `cameras` table, via
    camera_metadata.lookup) and geo.haversine_km, mirroring how
    get_vehicle_trace already derives speed for a single plate's route.
    A pair where either camera's coordinates are unknown is dropped rather
    than returned with a null speed -- the frontend draws every returned
    pair as a colored corridor, and a corridor with no speed to color by
    isn't renderable.
    """
    joins = ""
    clauses, params = _time_window_clauses(window_minutes, hour, on_date)

    if dept is not None:
        joins = "JOIN cameras c ON c.id = detections.camera_id"
        clauses.append("c.dept = %s")
        params.append(dept)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    db.execute(
        f"""
        WITH ordered AS (
            SELECT detections.plate_number, detections.camera_id, detections.detected_at,
                   LEAD(detections.camera_id) OVER (
                       PARTITION BY detections.plate_number ORDER BY detections.detected_at
                   ) AS next_camera_id,
                   LEAD(detections.detected_at) OVER (
                       PARTITION BY detections.plate_number ORDER BY detections.detected_at
                   ) AS next_detected_at
            FROM detections {joins}
            {where}
        ),
        transitions AS (
            SELECT camera_id AS from_camera_id, next_camera_id AS to_camera_id,
                   EXTRACT(EPOCH FROM (next_detected_at - detected_at)) AS gap_seconds
            FROM ordered
            WHERE next_camera_id IS NOT NULL
              AND next_camera_id != camera_id
              AND next_detected_at > detected_at
              AND next_detected_at - detected_at <= (%s || ' hours')::interval
        )
        SELECT from_camera_id, to_camera_id,
               COUNT(*) AS transitions, AVG(gap_seconds) AS avg_gap_seconds
        FROM transitions
        GROUP BY from_camera_id, to_camera_id
        ORDER BY transitions DESC
        LIMIT %s
        """,
        [*params, MAX_FLOW_TRANSITION_GAP_HOURS, limit],
    )
    pairs = db.fetchall()

    metadata_cache: dict[int, dict] = {}

    def _metadata(camera_id: int) -> dict:
        if camera_id not in metadata_cache:
            metadata_cache[camera_id] = camera_metadata.lookup(db, camera_id)
        return metadata_cache[camera_id]

    flows = []
    for pair in pairs:
        from_meta = _metadata(pair["from_camera_id"])
        to_meta = _metadata(pair["to_camera_id"])
        if None in (from_meta["latitude"], from_meta["longitude"], to_meta["latitude"], to_meta["longitude"]):
            continue
        distance_km = geo.haversine_km(
            from_meta["latitude"], from_meta["longitude"], to_meta["latitude"], to_meta["longitude"]
        )
        avg_gap_hours = float(pair["avg_gap_seconds"]) / 3600
        flows.append(
            {
                "from_camera_id": pair["from_camera_id"],
                "to_camera_id": pair["to_camera_id"],
                "transitions": pair["transitions"],
                "avg_speed_kmh": round(distance_km / avg_gap_hours, 1) if avg_gap_hours > 0 else None,
            }
        )
    return flows


def get_vehicle_trace(
    db: RealDictCursor,
    plate_number: str,
    scenario_run_id: str | None = None,
    date_from=None,
    date_to=None,
):
    """Sightings for one plate, ordered oldest-first for a route/timeline
    view, each enriched with camera metadata (see camera_metadata.py -- the
    real registered camera when one exists, the hardcoded vehicle-trace-demo
    entry otherwise) plus, from the second sighting onward, the inferred
    bearing/speed of the leg from the previous sighting to this one (see
    geo.leg_bearing_and_speed).

    scenario_run_id narrows to one replay run; omitted, it returns every
    sighting for the plate across all runs and live detections alike.
    date_from/date_to bound the range by detected_at, same convention as
    search_detections above -- an investigator narrowing a months-old plate
    history to the window that actually matters."""
    clauses = ["plate_number = %s"]
    params: list = [normalize_plate(plate_number)]
    if scenario_run_id is not None:
        clauses.append("scenario_run_id = %s")
        params.append(scenario_run_id)
    if date_from is not None:
        clauses.append("detected_at >= %s")
        params.append(date_from)
    if date_to is not None:
        clauses.append("detected_at <= %s")
        params.append(date_to)

    db.execute(
        f"SELECT * FROM detections WHERE {' AND '.join(clauses)} ORDER BY detected_at ASC",
        params,
    )
    sightings = db.fetchall()
    for sighting in sightings:
        sighting.update(camera_metadata.lookup(db, sighting["camera_id"]))

    for i, sighting in enumerate(sightings):
        sighting["bearing_deg"] = None
        sighting["speed_kmh"] = None
        sighting["anomaly"] = None
        if i == 0:
            continue
        prev = sightings[i - 1]
        sighting["bearing_deg"], sighting["speed_kmh"] = geo.leg_bearing_and_speed(prev, sighting)
        gap_hours = (sighting["detected_at"] - prev["detected_at"]).total_seconds() / 3600
        sighting["anomaly"] = geo.classify_leg_anomaly(sighting["speed_kmh"], gap_hours)

    return sightings


# How far back to look when mining historical camera-to-camera transitions
# for predict_next_camera -- bounds the window-function query below to a
# recent slice of `detections` instead of scanning the whole append-only
# table as it grows indefinitely.
PREDICTION_LOOKBACK_DAYS = 90


def predict_next_camera(db: RealDictCursor, camera_id: int, limit: int = 3) -> list[dict]:
    """The most common next-camera transitions historically observed after a
    plate was seen at `camera_id`, across every plate's history (not just the
    plate currently being traced -- one plate's own history is almost always
    too sparse to predict from by itself; the *network's* aggregate movement
    pattern is what makes a prediction meaningful). Returns up to `limit`
    candidates, ordered by how often that transition happened, each with a
    confidence = its share of every transition ever observed leaving this
    camera. Empty when this camera has no observed outbound transitions yet."""
    db.execute(
        """
        WITH ordered AS (
            SELECT plate_number, camera_id,
                   LEAD(camera_id) OVER (PARTITION BY plate_number ORDER BY detected_at) AS next_camera_id
            FROM detections
            WHERE detected_at > now() - (%s || ' days')::interval
        ),
        from_this_camera AS (
            SELECT next_camera_id FROM ordered
            WHERE camera_id = %s AND next_camera_id IS NOT NULL AND next_camera_id != camera_id
        )
        SELECT next_camera_id AS camera_id, COUNT(*) AS transitions,
               COUNT(*)::float / SUM(COUNT(*)) OVER () AS confidence
        FROM from_this_camera
        GROUP BY next_camera_id
        ORDER BY transitions DESC
        LIMIT %s
        """,
        (PREDICTION_LOOKBACK_DAYS, camera_id, limit),
    )
    candidates = db.fetchall()
    for candidate in candidates:
        candidate["camera_name"] = camera_metadata.lookup(db, candidate["camera_id"])["camera_name"]
    return candidates
