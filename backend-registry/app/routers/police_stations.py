"""Police station CRUD -- reference data used elsewhere (e.g. the "nearest
station" lookup on a watchlist alert in backend-watchlist)."""
from fastapi import APIRouter, Depends, HTTPException

from ..auth import get_current_user, require_permission
from ..db import get_conn
from ..rbac_scope import effective_district_scopes, guard_dept_in_scope, resolve_district_scoped
from ..schemas import PoliceStationCreate, PoliceStationOut, PoliceStationUpdate
from ..services import audit_service, police_stations_service

router = APIRouter(prefix="/police-stations", tags=["police stations"])


def _require_station_in_scope(conn, station_id: int, user: dict, *, audit_denial: bool = False) -> dict:
    """Same shape as cameras.py's _require_camera_in_scope: 404 for a
    station that doesn't exist, 403 for one outside the officer's own
    jurisdiction. audit_denial=True (update/delete) also logs the denied
    cross-district write attempt; plain GET stays unaudited (low-signal)."""
    station = police_stations_service.get_station(conn, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Police station not found")
    dept_scopes = effective_district_scopes(user)
    if dept_scopes is not None and station["district"] not in dept_scopes:
        if audit_denial:
            audit_service.log(
                conn, user.get("badge_number", user.get("sub")), "access_denied_scope", "police_station", station_id,
                reason_code=f"station in {station['district']}, scoped to {', '.join(dept_scopes) or 'none'}",
            )
        raise HTTPException(status_code=403, detail="Police station outside your jurisdiction")
    return station


@router.get("", response_model=list[PoliceStationOut])
def list_police_stations(user=Depends(get_current_user)):
    with get_conn() as conn:
        return resolve_district_scoped(
            effective_district_scopes(user),
            lambda: police_stations_service.list_stations(conn),
            lambda d: police_stations_service.list_stations(conn, district=d),
        )


@router.get("/{station_id}", response_model=PoliceStationOut)
def get_police_station(station_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        return _require_station_in_scope(conn, station_id, user)


@router.post("", response_model=PoliceStationOut, status_code=201)
def create_police_station(body: PoliceStationCreate, user=Depends(require_permission("manage_stations"))):
    with get_conn() as conn:
        guard_dept_in_scope(conn, user, body.district, "police_station")
        created = police_stations_service.create_station(conn, body.model_dump())
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "police_station", created["id"])
        return created


@router.put("/{station_id}", response_model=PoliceStationOut)
def update_police_station(station_id: int, body: PoliceStationUpdate, user=Depends(require_permission("manage_stations"))):
    with get_conn() as conn:
        existing = _require_station_in_scope(conn, station_id, user, audit_denial=True)
        if body.district is not None and body.district != existing["district"]:
            guard_dept_in_scope(conn, user, body.district, "police_station", station_id)

        updated = police_stations_service.update_station(conn, station_id, body.model_dump(exclude_unset=True))
        if updated is None:
            raise HTTPException(status_code=404, detail="Police station not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "update", "police_station", station_id)
        return updated


@router.delete("/{station_id}", status_code=204)
def delete_police_station(station_id: int, user=Depends(require_permission("manage_stations"))):
    with get_conn() as conn:
        _require_station_in_scope(conn, station_id, user, audit_denial=True)
        deleted = police_stations_service.delete_station(conn, station_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Police station not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete", "police_station", station_id)
