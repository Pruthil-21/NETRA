"""Vehicle-trace query — "where has this plate been seen", enriched with
camera metadata, for frontend-map's route/timeline view.

Reuses the same detections history POST /detections writes to (see
routers/detections.py) rather than a separate store — a trace is just a
filtered, enriched read over that append-only table.
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query
from psycopg2.extras import RealDictCursor

from ..auth import require_permission
from ..database import get_db
from ..schemas import PredictNextCameraResponse, VehicleTraceResponse, normalize_plate
from ..services import audit_service, detections_service

router = APIRouter(prefix="/vehicle-traces", tags=["vehicle-traces"])


# Declared before "/{plate_number}" so this literal path segment ("predict-next")
# is matched first -- FastAPI/Starlette tries routes in declaration order, and
# {plate_number} would otherwise swallow this path too (a real plate never
# reads "predict-next", but the route order shouldn't depend on that).
@router.get("/predict-next/{camera_id}", response_model=PredictNextCameraResponse)
def predict_next_camera(
    camera_id: int,
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_permission("search_vehicles")),
):
    """Standalone form of the same prediction embedded in GET
    /vehicle-traces/{plate}'s `predicted_next` -- for a normal fuzzy-matched
    plate search (GET /detections), which never calls that endpoint at all
    (see detectionService.ts): given the last camera a plate was seen at,
    where has the network historically gone next from there."""
    candidates = detections_service.predict_next_camera(db, camera_id)
    return PredictNextCameraResponse(camera_id=camera_id, candidates=candidates)


@router.get("/{plate_number}", response_model=VehicleTraceResponse)
def get_vehicle_trace(
    plate_number: str,
    scenario_run_id: Optional[str] = Query(None),
    date_from: Optional[datetime] = Query(None, alias="from"),
    date_to: Optional[datetime] = Query(None, alias="to"),
    db: RealDictCursor = Depends(get_db),
    # Matches GET /detections' own gate (search_detections in
    # routers/detections.py) -- require_role("officer") would let any RBAC
    # role name through regardless of its actual permissions, which is
    # exactly the over-permissive gap that endpoint was fixed for; a plate's
    # full movement history deserves the same real permission check.
    user=Depends(require_permission("search_vehicles")),
):
    sightings = detections_service.get_vehicle_trace(db, plate_number, scenario_run_id, date_from, date_to)
    # Every trajectory query is audited -- who looked up which plate, over
    # what range, and when. Standard practice for any ALPR movement-history
    # feature (see IACP/NIJ model policy guidance on ALPR accountability):
    # the map is only half the feature, this is the other half.
    # resource_id stays None (that column is INTEGER, and a plate is text) --
    # reason_code is the free-text annotation field, exactly what it's for.
    audit_service.log(
        db, user.get("badge_number") or user.get("sub"), "search", "vehicle_trace",
        reason_code=normalize_plate(plate_number),
    )
    predicted_next = (
        detections_service.predict_next_camera(db, sightings[-1]["camera_id"]) if sightings else []
    )
    return VehicleTraceResponse(
        scenario_run_id=scenario_run_id,
        plate=normalize_plate(plate_number),
        sightings=sightings,
        predicted_next=predicted_next,
    )
