"""Miscellaneous platform-admin tools: the generic import/export job engine
(spec Section 3.7) shared across entity types."""
from fastapi import APIRouter, Depends, HTTPException, Query

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
    "cameras": "manage_cameras", "officers": "manage_users_roles", "audit_logs": "view_audit_logs",
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
                job = import_export_service.export_entity(conn, body.entity_type, body.format, run_by)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        audit_service.log(
            conn, run_by, f"data_job_{direction}", "import_export_job", job["id"], reason_code=body.entity_type
        )
        return job


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
