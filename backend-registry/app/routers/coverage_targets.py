"""Coverage-target CRUD -- fixed points the gap-analysis report (see
routers/reports.py) measures camera proximity against."""
from fastapi import APIRouter, Depends, HTTPException

from ..auth import get_current_user, require_permission
from ..db import get_conn
from ..schemas import CoverageTargetCreate, CoverageTargetOut, CoverageTargetUpdate
from ..services import audit_service, coverage_targets_service

router = APIRouter(prefix="/coverage-targets", tags=["coverage targets"])


@router.get("", response_model=list[CoverageTargetOut])
def list_coverage_targets(user=Depends(get_current_user)):
    with get_conn() as conn:
        return coverage_targets_service.list_targets(conn)


@router.get("/{target_id}", response_model=CoverageTargetOut)
def get_coverage_target(target_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        target = coverage_targets_service.get_target(conn, target_id)
        if target is None:
            raise HTTPException(status_code=404, detail="Coverage target not found")
        return target


@router.post("", response_model=CoverageTargetOut, status_code=201)
def create_coverage_target(body: CoverageTargetCreate, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        created = coverage_targets_service.create_target(conn, body.model_dump())
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "coverage_target", created["id"])
        return created


@router.put("/{target_id}", response_model=CoverageTargetOut)
def update_coverage_target(target_id: int, body: CoverageTargetUpdate, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        updated = coverage_targets_service.update_target(conn, target_id, body.model_dump(exclude_unset=True))
        if updated is None:
            raise HTTPException(status_code=404, detail="Coverage target not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "update", "coverage_target", target_id)
        return updated


@router.delete("/{target_id}", status_code=204)
def delete_coverage_target(target_id: int, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        deleted = coverage_targets_service.delete_target(conn, target_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Coverage target not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete", "coverage_target", target_id)
