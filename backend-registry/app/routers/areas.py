"""Area CRUD -- an area groups cameras within one village; a district-scoped
officer may only manage areas in their own jurisdiction (the village's
district, resolved via areas_service's join -- see districts.name's
compatibility note in scripts/build_data/fetch_gujarat_locations.py: it's
kept byte-for-byte equal to cameras.dept's existing values specifically so
this string comparison keeps working unchanged)."""
from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth import get_current_user, require_permission
from ..db import get_conn
from ..rbac_scope import effective_district_scopes, resolve_district_scoped
from ..schemas import AreaCreate, AreaOut, AreaUpdate
from ..services import areas_service, audit_service, locations_service

router = APIRouter(prefix="/areas", tags=["areas"])


def _guard_area_district(user: dict, district: str):
    """District-scoped users may only create/edit/delete areas in one of
    their own effective jurisdictions -- the union of every active
    posting's district (spec Section 3.3) -- same guard
    routers/postings.py's create_posting already applies."""
    scopes = effective_district_scopes(user)
    if scopes is not None and district not in scopes:
        raise HTTPException(status_code=403, detail="Cannot manage areas outside your own district")


@router.get("", response_model=list[AreaOut])
def list_areas(
    village_id: int | None = None,
    search: str | None = Query(default=None, min_length=1),
    user=Depends(get_current_user),
):
    with get_conn() as conn:
        return resolve_district_scoped(
            effective_district_scopes(user),
            lambda: areas_service.list_areas(conn, village_id=village_id, search=search),
            lambda d: areas_service.list_areas(conn, district_name=d, village_id=village_id, search=search),
        )


@router.get("/{area_id}", response_model=AreaOut)
def get_area(area_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        area = areas_service.get_area(conn, area_id)
        if area is None:
            raise HTTPException(status_code=404, detail="Area not found")
        return area


@router.post("", response_model=AreaOut, status_code=201)
def create_area(body: AreaCreate, user=Depends(require_permission("manage_areas"))):
    with get_conn() as conn:
        village_path = locations_service.get_village_path(conn, body.village_id)
        if village_path is None:
            raise HTTPException(status_code=400, detail="Unknown village")
        _guard_area_district(user, village_path["district"])
        try:
            created = areas_service.create_area(conn, body.model_dump())
        except areas_service.DuplicateAreaError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "area", created["id"])
        return created


@router.put("/{area_id}", response_model=AreaOut)
def update_area(area_id: int, body: AreaUpdate, user=Depends(require_permission("manage_areas"))):
    with get_conn() as conn:
        existing = areas_service.get_area(conn, area_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Area not found")
        _guard_area_district(user, existing["district"])
        if body.village_id is not None and body.village_id != existing["village_id"]:
            village_path = locations_service.get_village_path(conn, body.village_id)
            if village_path is None:
                raise HTTPException(status_code=400, detail="Unknown village")
            _guard_area_district(user, village_path["district"])
            if areas_service.camera_count_for_area(conn, area_id) > 0:
                raise HTTPException(
                    status_code=400,
                    detail="Cannot change the village of an area that still has cameras assigned",
                )
        try:
            updated = areas_service.update_area(conn, area_id, body.model_dump(exclude_unset=True))
        except areas_service.DuplicateAreaError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "update", "area", area_id)
        return updated


@router.delete("/{area_id}", status_code=204)
def delete_area(area_id: int, user=Depends(require_permission("manage_areas"))):
    with get_conn() as conn:
        existing = areas_service.get_area(conn, area_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Area not found")
        _guard_area_district(user, existing["district"])
        try:
            deleted = areas_service.delete_area(conn, area_id)
        except areas_service.AreaInUseError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if not deleted:
            raise HTTPException(status_code=404, detail="Area not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete", "area", area_id)
