"""Read-only audit log search, district-scoped the same way as
routers/cameras.py's list_cameras."""
from datetime import datetime

from fastapi import APIRouter, Depends, Query

from ..auth import require_permission
from ..db import get_conn
from ..rbac_scope import effective_district_scopes
from ..schemas import AuditLogsPage
from ..services import audit_logs_service

router = APIRouter(prefix="/audit-logs", tags=["audit logs"])


@router.get("", response_model=AuditLogsPage)
def list_audit_logs(
    badge_number: str | None = None,
    resource_type: str | None = None,
    category: str | None = None,
    camera_id: int | None = None,
    camera_district: str | None = None,
    camera_area_id: int | None = None,
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    cursor: int | None = None,
    limit: int = Query(50, ge=1, le=200),
    user=Depends(require_permission("view_audit_logs")),
):
    # Same multi-posting jurisdiction union as list_cameras (spec Section
    # 3.3); cursor pagination doesn't compose across several districts, so a
    # genuinely multi-posted officer's primary district is used here rather
    # than a true cross-district merge -- [] (no jurisdiction) returns an
    # empty page instead of silently falling back to unfiltered.
    dept_scopes = effective_district_scopes(user)
    if dept_scopes == []:
        return {"logs": [], "next_cursor": None}
    district = dept_scopes[0] if dept_scopes else None
    with get_conn() as conn:
        logs, next_cursor = audit_logs_service.list_logs(
            conn, badge_number, resource_type, category, camera_id, camera_district, camera_area_id,
            date_from, date_to, district, cursor, limit,
        )
        return {"logs": logs, "next_cursor": next_cursor}


@router.get("/categories")
def list_audit_log_categories(user=Depends(require_permission("view_audit_logs"))):
    """Backs the category filter chips -- keeps the frontend from having to
    duplicate the action/resource_type -> category mapping (single source of
    truth stays audit_logs_service.CATEGORIES)."""
    return {"categories": list(audit_logs_service.CATEGORIES.keys()) + ["other"]}
