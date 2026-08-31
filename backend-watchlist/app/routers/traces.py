"""Vehicle-trace query — "where has this plate been seen", enriched with
camera metadata, for frontend-map's route/timeline view.

Reuses the same detections history POST /detections writes to (see
routers/detections.py) rather than a separate store — a trace is just a
filtered, enriched read over that append-only table.
"""
from typing import Optional

from fastapi import APIRouter, Depends, Query
from psycopg2.extras import RealDictCursor

from ..auth import require_role
from ..database import get_db
from ..schemas import VehicleTraceResponse, normalize_plate
from ..services import detections_service

router = APIRouter(prefix="/vehicle-traces", tags=["vehicle-traces"])


@router.get("/{plate_number}", response_model=VehicleTraceResponse)
def get_vehicle_trace(
    plate_number: str,
    scenario_run_id: Optional[str] = Query(None),
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_role("officer")),
):
    sightings = detections_service.get_vehicle_trace(db, plate_number, scenario_run_id)
    return VehicleTraceResponse(
        scenario_run_id=scenario_run_id,
        plate=normalize_plate(plate_number),
        sightings=sightings,
    )
