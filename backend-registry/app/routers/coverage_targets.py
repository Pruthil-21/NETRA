"""Coverage-target CRUD -- fixed points the gap-analysis report (see
routers/reports.py) measures camera proximity against."""
from fastapi import APIRouter, Depends, HTTPException

from ..auth import get_current_user, require_permission
from ..db import get_conn
from ..rbac_scope import (
    effective_district_scopes,
    guard_dept_in_scope,
    resolve_district_scoped,
)
from ..schemas import CoverageTargetCreate, CoverageTargetOut, CoverageTargetUpdate
from ..services import audit_service, coverage_targets_service

router = APIRouter(prefix="/coverage-targets", tags=["coverage targets"])


def _require_target_in_scope(conn, target_id: int, user: dict, *, audit_denial: bool = False) -> dict:
    """Same shape as cameras.py's _require_camera_in_scope: 404 for a
    target that doesn't exist, 403 for one outside the officer's own
    jurisdiction. audit_denial=True (update/delete) also logs the denied
    cross-district write attempt; plain GET stays unaudited (low-signal)."""
    target = coverage_targets_service.get_target(conn, target_id)
    if target is None:
        raise HTTPException(status_code=404, detail="Coverage target not found")
    dept_scopes = effective_district_scopes(user)
    if dept_scopes is not None and target["district"] not in dept_scopes:
        if audit_denial:
            audit_service.log(
                conn, user.get("badge_number", user.get("sub")), "access_denied_scope", "coverage_target", target_id,
                reason_code=f"target in {target['district']}, scoped to {', '.join(dept_scopes) or 'none'}",
            )
        raise HTTPException(status_code=403, detail="Coverage target outside your jurisdiction")
    return target


@router.get("", response_model=list[CoverageTargetOut])
def list_coverage_targets(user=Depends(get_current_user)):
    with get_conn() as conn:
        return resolve_district_scoped(
            effective_district_scopes(user),
            lambda: coverage_targets_service.list_targets(conn),
            lambda d: coverage_targets_service.list_targets(conn, district=d),
        )


@router.get("/{target_id}", response_model=CoverageTargetOut)
def get_coverage_target(target_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        return _require_target_in_scope(conn, target_id, user)


@router.post("", response_model=CoverageTargetOut, status_code=201)
def create_coverage_target(body: CoverageTargetCreate, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        guard_dept_in_scope(conn, user, body.district, "coverage_target")
        created = coverage_targets_service.create_target(conn, body.model_dump())
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "coverage_target", created["id"])
        return created


@router.put("/{target_id}", response_model=CoverageTargetOut)
def update_coverage_target(target_id: int, body: CoverageTargetUpdate, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        existing = _require_target_in_scope(conn, target_id, user, audit_denial=True)
        if body.district is not None and body.district != existing["district"]:
            guard_dept_in_scope(conn, user, body.district, "coverage_target", target_id)

        updated = coverage_targets_service.update_target(conn, target_id, body.model_dump(exclude_unset=True))
        if updated is None:
            raise HTTPException(status_code=404, detail="Coverage target not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "update", "coverage_target", target_id)
        return updated


@router.delete("/{target_id}", status_code=204)
def delete_coverage_target(target_id: int, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        _require_target_in_scope(conn, target_id, user, audit_denial=True)
        deleted = coverage_targets_service.delete_target(conn, target_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Coverage target not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete", "coverage_target", target_id)
