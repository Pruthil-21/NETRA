# backend-registry/app/services/import_export_service.py
"""Generic import/export engine (v2 spec Section 3.7), modeled on D365's
Data Management Framework: one entity_type/direction/format job, not a
one-off importer per table. Every import validates each row independently
before committing it (never all-or-nothing), tracks a per-row execution
log, and supports re-submitting only the rows that failed.

Rows arrive pre-parsed (a list of dicts), not as a raw CSV/XLSX file --
the caller (or a thin frontend upload step) parses the file into rows
first. This keeps the engine itself format-agnostic and avoids
implementing multipart file parsing for what the spec treats as a detail
("Claude Code should design exact request/response shapes per its own
conventions").

Scope: two entity types wired up end-to-end (cameras, officers) --
covering both a georeferenced resource and a people-lifecycle one, the two
shapes every other entity type in this spec would follow. Adding another
entity type is one more ENTITY_HANDLERS entry, not a new engine."""
import csv
import io
import json

from openpyxl import Workbook
from pydantic import ValidationError

from ..schemas import CameraCreate
from . import (
    areas_service,
    audit_logs_service,
    auth_service,
    cameras_service,
    coverage_targets_service,
    police_stations_service,
    registration_service,
)


def _validate_camera_row(conn, row: dict):
    try:
        validated = CameraCreate(**row)
    except ValidationError as e:
        reason = "; ".join(f"{'.'.join(str(loc) for loc in err['loc'])}: {err['msg']}" for err in e.errors())
        return None, reason
    return validated.model_dump(), None


def _commit_camera_row(conn, data: dict) -> dict:
    return cameras_service.create_camera(conn, data)


def _export_cameras(conn, filters: dict) -> list[dict]:
    return cameras_service.list_cameras(conn, filters.get("district"))


_REQUIRED_OFFICER_FIELDS = {"badge_number", "name", "password"}


def _validate_officer_row(conn, row: dict):
    missing = _REQUIRED_OFFICER_FIELDS - row.keys()
    if missing:
        return None, f"missing required field(s): {', '.join(sorted(missing))}"
    if auth_service.get_officer_by_badge(conn, row["badge_number"]) is not None:
        return None, f"badge number '{row['badge_number']}' is already registered"
    return row, None


def _commit_officer_row(conn, data: dict) -> dict:
    """Bulk officer import lands exactly where self-registration does --
    status='pending' plus a registration_requests row -- so a bulk-onboarded
    roster still goes through the same approval queue (spec Section 3.2),
    never a backdoor around it."""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO officers (badge_number, name, rank, password_hash, status) "
            "VALUES (%s, %s, %s, %s, 'pending') RETURNING id",
            (data["badge_number"], data["name"], data.get("rank"), auth_service.hash_password(data["password"])),
        )
        officer_id = cur.fetchone()[0]
    conn.commit()
    registration_service.create_request(conn, officer_id, data.get("department"), data.get("contact_info"))
    return {"id": officer_id, "badge_number": data["badge_number"]}


def _export_officers(conn, filters: dict) -> list[dict]:
    clauses = []
    params: list = []
    if filters.get("status"):
        clauses.append("status = %s")
        params.append(filters["status"])
    if filters.get("date_from"):
        clauses.append("created_at >= %s")
        params.append(filters["date_from"])
    if filters.get("date_to"):
        clauses.append("created_at <= %s")
        params.append(filters["date_to"])
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT id, badge_number, name, rank, status, created_at FROM officers {where} ORDER BY badge_number",
            params,
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def _export_audit_logs(conn, filters: dict) -> list[dict]:
    """Ties the audit log viewer into this generic exporter rather than
    being its own one-off. list_logs is paginated (max 200/page, an
    officer scrolling a live view) -- an export instead pages through
    every match via its own cursor contract until exhausted, so a filtered
    export is genuinely complete, not silently truncated at one page."""
    logs: list[dict] = []
    cursor = None
    while True:
        page, cursor = audit_logs_service.list_logs(
            conn,
            badge_number=filters.get("badge_number"),
            resource_type=filters.get("resource_type"),
            category=filters.get("category"),
            district=filters.get("district"),
            date_from=filters.get("date_from"),
            date_to=filters.get("date_to"),
            cursor=cursor,
            limit=200,
        )
        logs.extend(page)
        if cursor is None:
            break
    return logs


def _export_postings(conn, filters: dict) -> list[dict]:
    clauses = []
    params: list = []
    if filters.get("role"):
        clauses.append("r.name = %s")
        params.append(filters["role"])
    if filters.get("scope_type"):
        clauses.append("p.scope_type = %s")
        params.append(filters["scope_type"])
    if filters.get("active_only"):
        clauses.append("p.is_active")
    if filters.get("date_from"):
        clauses.append("p.created_at >= %s")
        params.append(filters["date_from"])
    if filters.get("date_to"):
        clauses.append("p.created_at <= %s")
        params.append(filters["date_to"])
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT p.id, o.badge_number, o.name AS officer_name, r.name AS role,
                   p.scope_type, p.scope_value, p.is_active, p.assigned_by,
                   p.created_at, p.ended_at
            FROM postings p
            JOIN officers o ON o.id = p.officer_id
            JOIN roles r ON r.id = p.role_id
            {where}
            ORDER BY p.created_at DESC
            """,
            params,
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def _export_registration_requests(conn, filters: dict) -> list[dict]:
    clauses = []
    params: list = []
    if filters.get("status"):
        clauses.append("rr.status = %s")
        params.append(filters["status"])
    if filters.get("department"):
        clauses.append("rr.department = %s")
        params.append(filters["department"])
    if filters.get("date_from"):
        clauses.append("rr.created_at >= %s")
        params.append(filters["date_from"])
    if filters.get("date_to"):
        clauses.append("rr.created_at <= %s")
        params.append(filters["date_to"])
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT rr.id, o.badge_number, o.name, rr.department, rr.contact_info, rr.status,
                   rr.reviewed_by, rr.reviewed_at, rr.rejection_reason, rr.created_at
            FROM registration_requests rr
            JOIN officers o ON o.id = rr.officer_id
            {where}
            ORDER BY rr.created_at DESC
            """,
            params,
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def _export_camera_status_history(conn, filters: dict) -> list[dict]:
    return cameras_service.list_camera_status_history(
        conn,
        camera_id=filters.get("camera_id"),
        district=filters.get("district"),
        date_from=filters.get("date_from"),
        date_to=filters.get("date_to"),
    )


def _filter_by_district(rows: list[dict], filters: dict) -> list[dict]:
    """Shared by the small reference-data exports below (areas/police
    stations/coverage targets) -- none of their own list_* functions
    support server-side district filtering, and at this table size (tens
    to low hundreds of rows) filtering the already-fetched list in Python
    is simpler than adding a WHERE clause to three separate services for
    one shared filter."""
    district = filters.get("district")
    if not district:
        return rows
    return [r for r in rows if r.get("district") == district]


def _export_areas(conn, filters: dict) -> list[dict]:
    # areas_service.list_areas already filters server-side -- no need
    # for the Python-side _filter_by_district helper the two tables below
    # (which have no such support) rely on.
    return areas_service.list_areas(conn, filters.get("district"))


_REQUIRED_AREA_FIELDS = {"name", "district", "taluka", "village"}


def _validate_area_row(conn, row: dict):
    """Bulk area import takes human-readable district/taluka/village names
    (a spreadsheet author has no reason to know internal village_id numbers),
    resolved here against the seeded reference hierarchy -- an unmatched
    triple is reported back as this row's specific error, not a generic
    foreign-key failure at commit time."""
    missing = _REQUIRED_AREA_FIELDS - {k for k in row if str(row.get(k) or "").strip()}
    if missing:
        return None, f"missing required field(s): {', '.join(sorted(missing))}"
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT v.id FROM villages v
            JOIN talukas t ON t.id = v.taluka_id
            JOIN districts d ON d.id = t.district_id
            WHERE d.name = %s AND t.name = %s AND v.name = %s
            """,
            (row["district"].strip(), row["taluka"].strip(), row["village"].strip()),
        )
        match = cur.fetchone()
    if match is None:
        return None, (
            f"no village '{row['village']}' found in taluka '{row['taluka']}', "
            f"district '{row['district']}' -- check spelling against the Areas page's pickers"
        )
    return {"name": row["name"].strip(), "village_id": match[0]}, None


def _commit_area_row(conn, data: dict) -> dict:
    return areas_service.create_area(conn, data)


def _export_police_stations(conn, filters: dict) -> list[dict]:
    return _filter_by_district(police_stations_service.list_stations(conn), filters)


def _export_coverage_targets(conn, filters: dict) -> list[dict]:
    return _filter_by_district(coverage_targets_service.list_targets(conn), filters)


def _export_plate_sightings(conn, filters: dict) -> list[dict]:
    """Raw detections rows (backend-watchlist's plate-sighting history) --
    same cross-service-same-DB pattern reports_service already uses for
    watchlist tables (they're separate codebases sharing one physical
    Postgres instance, not separate databases)."""
    clauses = []
    params: list = []
    if filters.get("plate_number"):
        clauses.append("d.plate_number = %s")
        params.append("".join(filters["plate_number"].split()).upper())
    if filters.get("camera_id"):
        clauses.append("d.camera_id = %s")
        params.append(filters["camera_id"])
    if filters.get("date_from"):
        clauses.append("d.detected_at >= %s")
        params.append(filters["date_from"])
    if filters.get("date_to"):
        clauses.append("d.detected_at <= %s")
        params.append(filters["date_to"])
    joins = ""
    if filters.get("district"):
        joins = "JOIN cameras c ON c.id = d.camera_id"
        clauses.append("c.dept = %s")
        params.append(filters["district"])
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT d.id, d.plate_number, d.camera_id, d.detected_at, d.confidence, d.source
            FROM detections d {joins}
            {where}
            ORDER BY d.detected_at DESC
            """,
            params,
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def _export_traffic_alerts(conn, filters: dict) -> list[dict]:
    """Congestion alerts (density/flow threshold breaches) -- see
    backend-watchlist's traffic_alerts table/traffic_alerts_service, same
    cross-service-same-DB pattern as _export_plate_sightings above."""
    clauses = []
    params: list = []
    if filters.get("status"):
        clauses.append("status = %s")
        params.append(filters["status"])
    if filters.get("alert_type"):
        clauses.append("alert_type = %s")
        params.append(filters["alert_type"])
    if filters.get("district"):
        clauses.append("district = %s")
        params.append(filters["district"])
    if filters.get("date_from"):
        clauses.append("triggered_at >= %s")
        params.append(filters["date_from"])
    if filters.get("date_to"):
        clauses.append("triggered_at <= %s")
        params.append(filters["date_to"])
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with conn.cursor() as cur:
        cur.execute(f"SELECT * FROM traffic_alerts {where} ORDER BY triggered_at DESC", params)
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def _live_or_hour_window_clauses(filters: dict) -> tuple[list[str], list]:
    """The live-vs-hour window filter shared by _export_traffic_density and
    _export_traffic_flows below -- duplicated from backend-watchlist's
    detections_service._time_window_clauses (same reasoning as
    _export_plate_sightings: separate codebases, one shared Postgres
    instance, no cross-service Python import)."""
    window_minutes = filters.get("window_minutes")
    hour = filters.get("hour")
    if (window_minutes is None) == (hour is None):
        raise ValueError("Provide exactly one of window_minutes (live) or hour (time-of-day playback)")
    if window_minutes is not None:
        return ["d.detected_at >= now() - (%s || ' minutes')::interval"], [window_minutes]
    return (
        [
            "(d.detected_at AT TIME ZONE 'Asia/Kolkata')::date = %s",
            "EXTRACT(HOUR FROM d.detected_at AT TIME ZONE 'Asia/Kolkata') = %s",
        ],
        [filters.get("date"), hour],
    )


def _export_traffic_density(conn, filters: dict) -> list[dict]:
    """Per-camera detection counts for the same live/hour-window snapshot
    the Map page's density layer shows -- see backend-watchlist's
    detections_service.camera_density_counts."""
    clauses, params = _live_or_hour_window_clauses(filters)
    joins = ""
    if filters.get("district"):
        joins = "JOIN cameras c ON c.id = d.camera_id"
        clauses.append("c.dept = %s")
        params.append(filters["district"])
    where = f"WHERE {' AND '.join(clauses)}"
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT d.camera_id, COUNT(*) AS count
            FROM detections d {joins}
            {where}
            GROUP BY d.camera_id
            ORDER BY count DESC
            """,
            params,
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


# Matches backend-watchlist's detections_service.MAX_FLOW_TRANSITION_GAP_HOURS.
_MAX_FLOW_TRANSITION_GAP_HOURS = 3


def _export_traffic_flows(conn, filters: dict) -> list[dict]:
    """Camera-to-camera transition volume and average speed for the same
    live/hour-window snapshot the Map page's Flow layer shows -- see
    backend-watchlist's detections_service.camera_flow_pairs. Speed is
    computed in SQL via ST_Distance on cameras.location (a native
    GEOGRAPHY column here in backend-registry) rather than the Python
    haversine helper camera_flow_pairs uses -- that helper exists there
    because backend-watchlist only has cameras' coordinates via a metadata
    lookup shim; backend-registry owns the table directly."""
    clauses, params = _live_or_hour_window_clauses(filters)
    joins = ""
    if filters.get("district"):
        joins = "JOIN cameras c ON c.id = d.camera_id"
        clauses.append("c.dept = %s")
        params.append(filters["district"])
    where = f"WHERE {' AND '.join(clauses)}"
    with conn.cursor() as cur:
        cur.execute(
            f"""
            WITH ordered AS (
                SELECT d.plate_number, d.camera_id, d.detected_at,
                       LEAD(d.camera_id) OVER (
                           PARTITION BY d.plate_number ORDER BY d.detected_at
                       ) AS next_camera_id,
                       LEAD(d.detected_at) OVER (
                           PARTITION BY d.plate_number ORDER BY d.detected_at
                       ) AS next_detected_at
                FROM detections d {joins}
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
            SELECT t.from_camera_id, t.to_camera_id, COUNT(*) AS transitions,
                   CASE WHEN AVG(t.gap_seconds) > 0
                        THEN ROUND((
                            ST_Distance(c1.location, c2.location) / 1000.0 / (AVG(t.gap_seconds) / 3600.0)
                        )::numeric, 1)
                        ELSE NULL END AS avg_speed_kmh
            FROM transitions t
            JOIN cameras c1 ON c1.id = t.from_camera_id
            JOIN cameras c2 ON c2.id = t.to_camera_id
            GROUP BY t.from_camera_id, t.to_camera_id, c1.location, c2.location
            ORDER BY transitions DESC
            """,
            [*params, _MAX_FLOW_TRANSITION_GAP_HOURS],
        )
        cols = [c.name for c in cur.description]
        rows = [dict(zip(cols, row)) for row in cur.fetchall()]
    # ROUND(...)::numeric comes back as a Decimal, which json.dumps(rows,
    # default=str) below would stringify instead of serializing as a
    # number (every other exported numeric column is a plain int/float
    # that doesn't hit this) -- cast explicitly so the API returns
    # avg_speed_kmh as a real number, matching CorridorFlow's shape on the
    # backend-watchlist side.
    for row in rows:
        if row["avg_speed_kmh"] is not None:
            row["avg_speed_kmh"] = float(row["avg_speed_kmh"])
    return rows


# Export-only entities: append-only/system-generated data (audit_logs,
# camera_status_history) or data whose only real "import" would be a
# sensitive RBAC/lifecycle action better done through its own dedicated
# endpoint (postings, registration_requests) -- none carry a
# validate/commit handler. create_import_job checks for that explicitly.
ENTITY_HANDLERS = {
    "cameras": {"validate": _validate_camera_row, "commit": _commit_camera_row, "export": _export_cameras},
    "officers": {"validate": _validate_officer_row, "commit": _commit_officer_row, "export": _export_officers},
    "audit_logs": {"export": _export_audit_logs},
    "postings": {"export": _export_postings},
    "registration_requests": {"export": _export_registration_requests},
    "camera_status_history": {"export": _export_camera_status_history},
    "areas": {"validate": _validate_area_row, "commit": _commit_area_row, "export": _export_areas},
    "police_stations": {"export": _export_police_stations},
    "coverage_targets": {"export": _export_coverage_targets},
    "plate_sightings": {"export": _export_plate_sightings},
    "traffic_alerts": {"export": _export_traffic_alerts},
    "traffic_density": {"export": _export_traffic_density},
    "traffic_flows": {"export": _export_traffic_flows},
}


def _row_to_dict(cur, row):
    if row is None:
        return None
    cols = [c.name for c in cur.description]
    return dict(zip(cols, row))


def get_job(conn, job_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, entity_type, direction, format, status, total_rows, success_rows, failed_rows, "
            "row_results, failed_rows_payload, filters, run_by, created_at FROM import_export_jobs WHERE id = %s",
            (job_id,),
        )
        return _row_to_dict(cur, cur.fetchone())


def list_jobs(conn, entity_type: str | None = None, limit: int = 50) -> list[dict]:
    """Job history for the Data Console panel -- newest first. Deliberately
    excludes row_results/failed_rows_payload (fetched separately via
    get_job when a caller actually wants one job's full detail) so a
    history list of, say, 50 jobs doesn't pull every row of every past
    export back over the wire just to render a list of summaries."""
    limit = max(1, min(limit, 200))
    clauses = []
    params: list = []
    if entity_type is not None:
        clauses.append("entity_type = %s")
        params.append(entity_type)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT id, entity_type, direction, format, status, total_rows, success_rows, failed_rows,
                   filters, run_by, created_at
            FROM import_export_jobs {where}
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (*params, limit),
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def _process_rows(conn, entity_type: str, rows: list[dict]) -> tuple[list[dict], list[dict], int]:
    handler = ENTITY_HANDLERS[entity_type]
    results = []
    failed_payload = []
    success = 0
    for index, row in enumerate(rows):
        data, error = handler["validate"](conn, row)
        if error is not None:
            results.append({"index": index, "status": "error", "reason": error, "row": row})
            failed_payload.append(row)
            continue
        try:
            handler["commit"](conn, data)
        except Exception as exc:  # noqa: BLE001 -- a valid-looking row can still fail at the DB layer
            conn.rollback()
            results.append({"index": index, "status": "error", "reason": str(exc), "row": row})
            failed_payload.append(row)
            continue
        results.append({"index": index, "status": "success", "row": row})
        success += 1
    return results, failed_payload, success


def create_import_job(conn, entity_type: str, format: str, rows: list[dict], run_by: str) -> dict:
    if entity_type not in ENTITY_HANDLERS:
        raise ValueError(f"Unknown entity_type '{entity_type}'")
    if "validate" not in ENTITY_HANDLERS[entity_type]:
        raise ValueError(f"Entity type '{entity_type}' does not support import")
    results, failed_payload, success = _process_rows(conn, entity_type, rows)
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO import_export_jobs
                (entity_type, direction, format, status, total_rows, success_rows, failed_rows,
                 row_results, failed_rows_payload, run_by)
            VALUES (%s, 'import', %s, 'committed', %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (entity_type, format, len(rows), success, len(rows) - success,
             json.dumps(results), json.dumps(failed_payload), run_by),
        )
        job_id = cur.fetchone()[0]
    conn.commit()
    return get_job(conn, job_id)


def resubmit_failed_rows(conn, job_id: int, run_by: str) -> dict | None:
    """Re-attempts only the rows recorded as failed on the original job --
    never the whole original file again (spec Section 3.7). Recorded as its
    own new job row (its own execution log), not a mutation of the
    original, so the original job's history stays intact."""
    job = get_job(conn, job_id)
    if job is None:
        return None
    failed_rows = job["failed_rows_payload"] or []
    if not failed_rows:
        return job
    return create_import_job(conn, job["entity_type"], job["format"], failed_rows, run_by)


def _export_rows(conn, entity_type: str, filters: dict) -> list[dict]:
    if entity_type not in ENTITY_HANDLERS:
        raise ValueError(f"Unknown entity_type '{entity_type}'")
    handler = ENTITY_HANDLERS[entity_type]
    if "export" not in handler:
        raise ValueError(f"Entity type '{entity_type}' does not support export")
    return handler["export"](conn, filters or {})


def preview_count(conn, entity_type: str, filters: dict) -> int:
    """How many rows this filter set would export, without creating a job
    row -- lets the Data Console show a live count before an officer
    commits to running it. Runs the same filtered query export_entity
    would and counts the result rather than a parallel COUNT(*) per
    entity: at this data's scale (hundreds to low thousands of rows, not
    millions) that's simpler and can never drift from what export
    actually returns."""
    return len(_export_rows(conn, entity_type, filters))


def export_entity(conn, entity_type: str, format: str, run_by: str, filters: dict | None = None) -> dict:
    filters = filters or {}
    rows = _export_rows(conn, entity_type, filters)
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO import_export_jobs
                (entity_type, direction, format, status, total_rows, success_rows, failed_rows,
                 row_results, filters, run_by)
            VALUES (%s, 'export', %s, 'committed', %s, %s, 0, %s, %s, %s)
            RETURNING id
            """,
            # default=str: several entities carry a datetime column (audit_logs'
            # timestamp, postings'/registration_requests' created_at, ...) --
            # json.dumps can't serialize that natively, and a plain str()
            # (ISO-ish) is exactly what an exported row should show anyway.
            (entity_type, format, len(rows), len(rows), json.dumps(rows, default=str), json.dumps(filters), run_by),
        )
        job_id = cur.fetchone()[0]
    conn.commit()
    return get_job(conn, job_id)


_CSV_FORMULA_PREFIXES = ("=", "+", "-", "@")


def _csv_safe(value) -> str:
    """Prefix any cell value starting with a character Excel/Sheets would
    interpret as the start of a formula with a leading single-quote, so a
    value like "=cmd(...)" written as literal text, never executed -- same
    guard backend-watchlist's detections CSV export already uses."""
    text = "" if value is None else str(value)
    if text.startswith(_CSV_FORMULA_PREFIXES):
        return "'" + text
    return text


def serialize_rows(rows: list[dict], format: str) -> tuple[bytes, str]:
    """Turns a job's already-fetched row_results into an actual
    downloadable file -- (content_bytes, media_type). Column order is
    every key across every row, first-seen order, since a real export
    (postings, registration_requests, ...) can have rows shaped slightly
    differently from each other and a fixed header still has to cover all
    of them."""
    columns: list[str] = []
    seen = set()
    for row in rows:
        for key in row:
            if key not in seen:
                seen.add(key)
                columns.append(key)

    if format == "json":
        return json.dumps(rows, default=str, indent=2).encode("utf-8"), "application/json"

    if format == "csv":
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(columns)
        for row in rows:
            writer.writerow([_csv_safe(row.get(col)) for col in columns])
        return buffer.getvalue().encode("utf-8"), "text/csv"

    if format == "xlsx":
        workbook = Workbook()
        sheet = workbook.active
        sheet.append(columns)
        for row in rows:
            # openpyxl rejects tz-aware datetimes outright and has no
            # formula-injection guard of its own -- every cell goes through
            # the same _csv_safe stringification CSV uses, so a plain-text
            # spreadsheet cell is exactly what an exported row shows here too.
            sheet.append([_csv_safe(row.get(col)) for col in columns])
        buffer = io.BytesIO()
        workbook.save(buffer)
        return buffer.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

    raise ValueError(f"Unsupported format '{format}'")
