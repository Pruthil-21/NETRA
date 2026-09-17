"""Read-only audit log search, district-scoped the same way as
routers/cameras.py's list_cameras."""
from datetime import datetime

from fastapi import APIRouter, Depends, Query

from ..auth import require_permission
from ..db import get_conn
from ..rbac_scope import effective_district_scopes
from ..schemas import AuditLogsPage, ChainVerifyResult
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


@router.get("/verify-chain", response_model=ChainVerifyResult)
def verify_audit_chain(user=Depends(require_permission("view_audit_logs"))):
    """Proves (or disproves) that no hash-chained audit row has been altered
    or removed since it was written -- see audit_service.log's module
    docstring. Gated on view_audit_logs, same as every other read here, so
    the platform-wide, permissions-free "Auditor" role (scripts/seed_rbac.py)
    can run this itself rather than needing to trust anyone else's word that
    the log is intact. Not district-scoped: chain integrity is a whole-table
    property, checking only a district's own rows can't prove anything about
    the chain as a whole."""
    with get_conn() as conn:
        return audit_logs_service.verify_chain(conn)
