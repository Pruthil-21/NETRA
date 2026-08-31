"""Detections — the permanent vehicle-sighting history.

POST is the single internal-service endpoint ml-anpr calls for every
confirmed plate read (not just watchlist matches): it records the sighting
and, if the plate is on the watchlist, also creates the linked alert — so
ml-anpr never has to call two endpoints for one event.

GET is officer-only search ("where has this plate been seen") for the
frontend route/timeline view.
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query
from psycopg2.extras import RealDictCursor

from ..auth import require_internal_key, require_role
from ..database import get_db
from ..logging_config import logger
from ..schemas import DetectionIn, DetectionOut, DetectionResult
from ..services import alerts_service, audit_service, detections_service

router = APIRouter(prefix="/detections", tags=["detections"])


@router.get("", response_model=list[DetectionOut])
def search_detections(
    plate_number: Optional[str] = Query(None),
    camera_id: Optional[int] = Query(None),
    date_from: Optional[datetime] = Query(None, alias="from"),
    date_to: Optional[datetime] = Query(None, alias="to"),
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_role("officer")),
):
    return detections_service.search_detections(db, plate_number, camera_id, date_from, date_to)


@router.post("", response_model=DetectionResult, status_code=201)
def receive_detection(
    detection: DetectionIn,
    db: RealDictCursor = Depends(get_db),
    _=Depends(require_internal_key),
):
    recorded = detections_service.record_detection(db, detection)
    audit_service.log(db, "ml-anpr", "create", "detection", recorded["id"])

    alert = alerts_service.process_detection(
        db, detection.camera_id, detection.plate_number, recorded["id"]
    )
    if alert is not None:
        audit_service.log(db, "ml-anpr", "create", "alert", alert["id"])
        logger.info(f"ALERT: blacklisted plate {detection.plate_number} detected at camera {detection.camera_id}")

    return {"detection": recorded, "alert": alert}
