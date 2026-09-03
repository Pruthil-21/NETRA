"""Manual plate -> government-database lookup for officers: VAHAN
(ownership) + eGujCop (crime/FIR records), both currently placeholders,
see services/govt_lookup_service.py. Separate from GET /vehicle-traces:
that returns sighting history (where a plate was seen); this returns
registry/police details (who owns it, is it flagged in a case).
"""
from fastapi import APIRouter, Depends

from ..auth import require_role
from ..services import govt_lookup_service

router = APIRouter(prefix="/vehicle-lookup", tags=["vehicle-lookup"])


@router.get("/{plate_number}")
def get_vehicle_lookup(plate_number: str, user=Depends(require_role("officer"))):
    return govt_lookup_service.lookup_vehicle(plate_number)
