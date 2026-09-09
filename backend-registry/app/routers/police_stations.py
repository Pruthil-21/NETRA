"""Police station CRUD -- reference data used elsewhere (e.g. the "nearest
station" lookup on a watchlist alert in backend-watchlist)."""
from fastapi import APIRouter, Depends, HTTPException

from ..auth import get_current_user, require_permission
from ..db import get_conn
from ..schemas import PoliceStationCreate, PoliceStationOut, PoliceStationUpdate
from ..services import audit_service, police_stations_service

router = APIRouter(prefix="/police-stations", tags=["police stations"])


@router.get("", response_model=list[PoliceStationOut])
def list_police_stations(user=Depends(get_current_user)):
    with get_conn() as conn:
        return police_stations_service.list_stations(conn)


@router.get("/{station_id}", response_model=PoliceStationOut)
def get_police_station(station_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        station = police_stations_service.get_station(conn, station_id)
        if station is None:
            raise HTTPException(status_code=404, detail="Police station not found")
        return station


@router.post("", response_model=PoliceStationOut, status_code=201)
def create_police_station(body: PoliceStationCreate, user=Depends(require_permission("manage_stations"))):
    with get_conn() as conn:
        created = police_stations_service.create_station(conn, body.model_dump())
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "police_station", created["id"])
        return created


@router.put("/{station_id}", response_model=PoliceStationOut)
def update_police_station(station_id: int, body: PoliceStationUpdate, user=Depends(require_permission("manage_stations"))):
    with get_conn() as conn:
        updated = police_stations_service.update_station(conn, station_id, body.model_dump(exclude_unset=True))
        if updated is None:
            raise HTTPException(status_code=404, detail="Police station not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "update", "police_station", station_id)
        return updated


@router.delete("/{station_id}", status_code=204)
def delete_police_station(station_id: int, user=Depends(require_permission("manage_stations"))):
    with get_conn() as conn:
        deleted = police_stations_service.delete_station(conn, station_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Police station not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete", "police_station", station_id)
