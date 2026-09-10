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
import json

from pydantic import ValidationError

from ..schemas import CameraCreate
from . import audit_logs_service, auth_service, cameras_service, registration_service


def _validate_camera_row(conn, row: dict):
    try:
        validated = CameraCreate(**row)
    except ValidationError as e:
        reason = "; ".join(f"{'.'.join(str(loc) for loc in err['loc'])}: {err['msg']}" for err in e.errors())
        return None, reason
    return validated.model_dump(), None


def _commit_camera_row(conn, data: dict) -> dict:
    return cameras_service.create_camera(conn, data)


def _export_cameras(conn) -> list[dict]:
    return cameras_service.list_cameras(conn, None)


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


def _export_officers(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute("SELECT id, badge_number, name, rank, status FROM officers ORDER BY badge_number")
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def _export_audit_logs(conn) -> list[dict]:
    """Ties the audit log viewer (spec Section 3.5) into this generic
    exporter rather than being its own one-off, per Section 3.5's own
    instruction. Capped at the most recent 1000 rows -- a full historical
    export honoring the viewer's live filter state is a natural follow-up,
    not implemented in this pass (GET /audit-logs already covers filtered
    *viewing*, which is the capability Section 3.5 is really about)."""
    logs, _ = audit_logs_service.list_logs(conn, limit=1000)
    return logs


# Export-only entity: audit_logs is an append-only, system-generated
# table -- "importing" one doesn't mean anything, so it carries no
# validate/commit handler. create_import_job checks for that explicitly.
ENTITY_HANDLERS = {
    "cameras": {"validate": _validate_camera_row, "commit": _commit_camera_row, "export": _export_cameras},
    "officers": {"validate": _validate_officer_row, "commit": _commit_officer_row, "export": _export_officers},
    "audit_logs": {"export": _export_audit_logs},
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
            "row_results, failed_rows_payload, run_by, created_at FROM import_export_jobs WHERE id = %s",
            (job_id,),
        )
        return _row_to_dict(cur, cur.fetchone())


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


def export_entity(conn, entity_type: str, format: str, run_by: str) -> dict:
    if entity_type not in ENTITY_HANDLERS:
        raise ValueError(f"Unknown entity_type '{entity_type}'")
    rows = ENTITY_HANDLERS[entity_type]["export"](conn)
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO import_export_jobs
                (entity_type, direction, format, status, total_rows, success_rows, failed_rows, row_results, run_by)
            VALUES (%s, 'export', %s, 'committed', %s, %s, 0, %s, %s)
            RETURNING id
            """,
            # default=str: audit_logs rows carry a datetime `timestamp` --
            # json.dumps can't serialize that natively, and a plain str()
            # (ISO-ish) is exactly what an exported row should show anyway.
            (entity_type, format, len(rows), len(rows), json.dumps(rows, default=str), run_by),
        )
        job_id = cur.fetchone()[0]
    conn.commit()
    return get_job(conn, job_id)
