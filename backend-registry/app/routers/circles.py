"""Circle CRUD -- a circle groups cameras within one district; a
district-scoped officer may only manage circles in their own jurisdiction."""
from fastapi import APIRouter, Depends, HTTPException

from ..auth import get_current_user, require_permission
from ..db import get_conn
from ..rbac_scope import effective_district_scopes, resolve_district_scoped
from ..schemas import CircleCreate, CircleOut, CircleUpdate
from ..services import audit_service, circles_service

router = APIRouter(prefix="/circles", tags=["circles"])


def _guard_circle_district(user: dict, district: str):
    """District-scoped users may only create/edit/delete circles in one of
    their own effective jurisdictions -- the union of every active
    posting's district (spec Section 3.3) -- same guard
    routers/postings.py's create_posting already applies."""
    scopes = effective_district_scopes(user)
    if scopes is not None and district not in scopes:
        raise HTTPException(status_code=403, detail="Cannot manage circles outside your own district")


@router.get("", response_model=list[CircleOut])
def list_circles(user=Depends(get_current_user)):
    with get_conn() as conn:
        return resolve_district_scoped(
            effective_district_scopes(user),
            lambda: circles_service.list_circles(conn, None),
            lambda d: circles_service.list_circles(conn, d),
        )


@router.get("/{circle_id}", response_model=CircleOut)
def get_circle(circle_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        circle = circles_service.get_circle(conn, circle_id)
        if circle is None:
            raise HTTPException(status_code=404, detail="Circle not found")
        return circle


@router.post("", response_model=CircleOut, status_code=201)
def create_circle(body: CircleCreate, user=Depends(require_permission("manage_circles"))):
    _guard_circle_district(user, body.district)
    with get_conn() as conn:
        try:
            created = circles_service.create_circle(conn, body.model_dump())
        except circles_service.DuplicateCircleError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "circle", created["id"])
        return created


@router.put("/{circle_id}", response_model=CircleOut)
def update_circle(circle_id: int, body: CircleUpdate, user=Depends(require_permission("manage_circles"))):
    with get_conn() as conn:
        existing = circles_service.get_circle(conn, circle_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Circle not found")
        _guard_circle_district(user, existing["district"])
        if body.district is not None:
            _guard_circle_district(user, body.district)
            if body.district != existing["district"] and circles_service.camera_count_for_circle(conn, circle_id) > 0:
                raise HTTPException(
                    status_code=400,
                    detail="Cannot change district of a circle that still has cameras assigned",
                )
        try:
            updated = circles_service.update_circle(conn, circle_id, body.model_dump(exclude_unset=True))
        except circles_service.DuplicateCircleError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "update", "circle", circle_id)
        return updated


@router.delete("/{circle_id}", status_code=204)
def delete_circle(circle_id: int, user=Depends(require_permission("manage_circles"))):
    with get_conn() as conn:
        existing = circles_service.get_circle(conn, circle_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Circle not found")
        _guard_circle_district(user, existing["district"])
        try:
            deleted = circles_service.delete_circle(conn, circle_id)
        except circles_service.CircleInUseError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if not deleted:
            raise HTTPException(status_code=404, detail="Circle not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete", "circle", circle_id)
