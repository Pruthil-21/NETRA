"""Read-only District -> Taluka -> Village hierarchy lookups. Any
authenticated officer can browse this -- it's government reference data, not
a jurisdiction-scoped resource (unlike areas/cameras); a Station Officer
picking an area for a new camera needs to search every village in Gujarat,
not just their own district."""
from fastapi import APIRouter, Depends, Query

from ..auth import get_current_user
from ..db import get_conn
from ..schemas import DistrictOut, TalukaOut, VillageOut
from ..services import locations_service

router = APIRouter(tags=["locations"])


@router.get("/districts", response_model=list[DistrictOut])
def list_districts():
    """No auth dependency, deliberately -- the public self-registration
    form (POST /auth/register) needs the canonical district list to
    populate its own District/Department dropdown before an officer has
    any token at all. Government reference data (district names), not a
    jurisdiction-scoped resource, so there's nothing sensitive to gate."""
    with get_conn() as conn:
        return locations_service.list_districts(conn)


@router.get("/talukas", response_model=list[TalukaOut])
def list_talukas(district_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        return locations_service.list_talukas(conn, district_id)


@router.get("/villages", response_model=list[VillageOut])
def search_villages(
    taluka_id: int | None = None,
    search: str | None = Query(default=None, min_length=1),
    limit: int = 50,
    user=Depends(get_current_user),
):
    with get_conn() as conn:
        return locations_service.search_villages(conn, taluka_id=taluka_id, search=search, limit=limit)
