"""Miscellaneous platform-admin tools: the generic import/export job engine
(spec Section 3.7) shared across entity types -- the Data Console."""
import json

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from ..auth import get_current_user, has_permission
from ..db import get_conn
from ..schemas import DataJobCreate, DataJobOut
from ..services import audit_service, import_export_service

router = APIRouter(prefix="/admin", tags=["admin tools"])


# Which permission gates import/export for a given entity_type (spec
# Section 3.7) -- generic across entity types, but each one still respects
# its own existing write permission rather than a single blanket import/
# export permission.
_DATA_JOB_ENTITY_PERMISSIONS = {
    "cameras": "manage_cameras",
    "officers": "manage_users_roles",
    "audit_logs": "view_audit_logs",
    "postings": "manage_users_roles",
    "registration_requests": "manage_users_roles",
    "camera_status_history": "manage_cameras",
    "areas": "manage_areas",
    "police_stations": "manage_stations",
    "coverage_targets": "manage_cameras",
    "plate_sightings": "view_analytics",
    "traffic_alerts": "view_analytics",
    "traffic_density": "view_analytics",
    "traffic_flows": "view_analytics",
}


def _require_data_job_permission(user: dict, entity_type: str) -> None:
    required = _DATA_JOB_ENTITY_PERMISSIONS.get(entity_type)
    if required is None:
        raise HTTPException(status_code=400, detail=f"Unknown entity_type '{entity_type}'")
    if not has_permission(user, required):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


@router.post("/data-jobs", response_model=DataJobOut, status_code=201)
def create_data_job(
    body: DataJobCreate, direction: str = Query(..., pattern="^(import|export)$"),
    user=Depends(get_current_user),
):
    _require_data_job_permission(user, body.entity_type)
    run_by = user.get("badge_number", user.get("sub", ""))
    with get_conn() as conn:
        try:
            if direction == "import":
                job = import_export_service.create_import_job(conn, body.entity_type, body.format, body.rows, run_by)
            else:
                job = import_export_service.export_entity(
                    conn, body.entity_type, body.format, run_by, body.filters
                )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        audit_service.log(
            conn, run_by, f"data_job_{direction}", "import_export_job", job["id"], reason_code=body.entity_type
        )
        return job


@router.get("/data-jobs/preview")
def preview_data_job(
    entity_type: str,
    filters: str = Query("{}", description="JSON-encoded filter object, same shape as DataJobCreate.filters"),
    user=Depends(get_current_user),
):
    """Row count for a filter set before an officer commits to running the
    export -- registered ahead of GET /data-jobs/{job_id} so "preview" is
    never mistaken for a job_id path parameter."""
    _require_data_job_permission(user, entity_type)
    try:
        parsed_filters = json.loads(filters)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="filters must be a JSON object")
    with get_conn() as conn:
        try:
            count = import_export_service.preview_count(conn, entity_type, parsed_filters)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"count": count}


@router.get("/data-jobs", response_model=list[DataJobOut])
def list_data_jobs(
    entity_type: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    user=Depends(get_current_user),
):
    if entity_type is not None:
        _require_data_job_permission(user, entity_type)
    with get_conn() as conn:
        jobs = import_export_service.list_jobs(conn, entity_type, limit)
    if entity_type is None:
        # No single entity_type to check up front -- keep only the jobs
        # for entity types this officer actually has permission for,
        # rather than exposing every job on the platform to anyone who can
        # reach this endpoint at all.
        jobs = [
            job for job in jobs
            if has_permission(user, _DATA_JOB_ENTITY_PERMISSIONS.get(job["entity_type"], ""))
        ]
    return jobs


@router.get("/data-jobs/{job_id}/download")
def download_data_job(job_id: int, format: str | None = Query(None), user=Depends(get_current_user)):
    with get_conn() as conn:
        job = import_export_service.get_job(conn, job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        _require_data_job_permission(user, job["entity_type"])
    rows = job["row_results"] or []
    try:
        content, media_type = import_export_service.serialize_rows(rows, format or job["format"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    extension = (format or job["format"])
    filename = f"{job['entity_type']}_{job_id}.{extension}"
    return Response(
        content=content, media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/data-jobs/{job_id}", response_model=DataJobOut)
def get_data_job(job_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        job = import_export_service.get_job(conn, job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        _require_data_job_permission(user, job["entity_type"])
        return job


@router.post("/data-jobs/{job_id}/resubmit-failed", response_model=DataJobOut)
def resubmit_data_job(job_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        existing = import_export_service.get_job(conn, job_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Job not found")
        _require_data_job_permission(user, existing["entity_type"])
        job = import_export_service.resubmit_failed_rows(
            conn, job_id, user.get("badge_number", user.get("sub", ""))
        )
        audit_service.log(
            conn, user.get("badge_number", user.get("sub")), "data_job_resubmit", "import_export_job", job_id
        )
        return job
