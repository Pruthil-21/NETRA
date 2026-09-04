"""Detections — the permanent vehicle-sighting history.

POST is the single internal-service endpoint ml-anpr calls for every
confirmed plate read (not just watchlist matches): it records the sighting
and, if the plate is on the watchlist, also creates the linked alert — so
ml-anpr never has to call two endpoints for one event.

GET is officer-only search ("where has this plate been seen") for the
frontend route/timeline view.
"""
import csv
import io
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from psycopg2.extras import RealDictCursor

from ..auth import has_permission, require_internal_key, require_role
from ..database import get_db
from ..logging_config import logger
from ..schemas import DetectionIn, DetectionOut, DetectionResult
from ..services import alerts_service, audit_service, detections_service

router = APIRouter(prefix="/detections", tags=["detections"])


@router.get("")
def search_detections(
    plate_number: Optional[str] = Query(None),
    camera_id: Optional[int] = Query(None),
    date_from: Optional[datetime] = Query(None, alias="from"),
    date_to: Optional[datetime] = Query(None, alias="to"),
    format: Optional[str] = Query(None),
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_role("officer")),
):
    dept = user.get("scope_value") if user.get("scope_type") == "district" else None
    results = detections_service.search_detections(db, plate_number, camera_id, date_from, date_to, dept)

    if format != "csv":
        return [DetectionOut(**r).model_dump(mode="json") for r in results]

    if not has_permission(user, "export_data"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["id", "plate_number", "camera_id", "detected_at", "confidence"])
    for r in results:
        writer.writerow([r["id"], r["plate_number"], r["camera_id"], r["detected_at"], r["confidence"]])
    return Response(content=buffer.getvalue(), media_type="text/csv")


@router.post("", response_model=DetectionResult, status_code=201)
def receive_detection(
    detection: DetectionIn,
    db: RealDictCursor = Depends(get_db),
    _=Depends(require_internal_key),
):
    recorded, is_duplicate = detections_service.record_detection(db, detection)

    if is_duplicate:
        # A retried/replayed event for a sighting already recorded — return
        # its original alert (if any) rather than matching against the
        # watchlist again, which would create a second alert for the same
        # underlying detection.
        alert = alerts_service.get_alert_by_detection_id(db, recorded["id"])
        return {"detection": recorded, "alert": alert}

    audit_service.log(db, "ml-anpr", "create", "detection", recorded["id"])

    alert = alerts_service.process_detection(
        db, detection.camera_id, detection.plate_number, recorded["id"]
    )
    if alert is not None:
        audit_service.log(db, "ml-anpr", "create", "alert", alert["id"])
        logger.info(f"ALERT: blacklisted plate {detection.plate_number} detected at camera {detection.camera_id}")

    return {"detection": recorded, "alert": alert}
