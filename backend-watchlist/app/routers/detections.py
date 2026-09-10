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
from datetime import date, datetime
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from psycopg2.extras import RealDictCursor

from ..auth import has_permission, require_internal_key, require_permission
from ..database import get_db
from ..logging_config import logger
from ..schemas import CorridorFlow, DensityPoint, DetectionIn, DetectionOut, DetectionResult
from ..services import alerts_service, audit_service, detections_service

_IST = ZoneInfo("Asia/Kolkata")

router = APIRouter(prefix="/detections", tags=["detections"])


def _resolve_window(window_minutes: Optional[int], hour: Optional[int], on_date: Optional[date]) -> date:
    """Shared by every Map-layer analytics endpoint below: exactly one of
    window_minutes (live, rolling) or hour (time-of-day playback) must be
    given -- the two are mutually exclusive views, never combined. Returns
    the resolved date for hour mode (today in IST when the caller omitted
    it); the return value is meaningless in window_minutes mode."""
    if (window_minutes is None) == (hour is None):
        raise HTTPException(
            status_code=400,
            detail="Provide exactly one of window_minutes (live) or hour (time-of-day playback)",
        )
    return on_date if hour is not None and on_date is not None else datetime.now(_IST).date()


_CSV_FORMULA_PREFIXES = ("=", "+", "-", "@")


def _csv_safe(value):
    """Prefix any cell value starting with a character Excel/Sheets would
    interpret as the start of a formula with a leading single-quote, so a
    plate/value like "=cmd(...)" is written as literal text, not executed."""
    text = str(value)
    if text.startswith(_CSV_FORMULA_PREFIXES):
        return "'" + text
    return text


@router.get("", responses={200: {"model": list[DetectionOut]}})
def search_detections(
    plate_number: Optional[str] = Query(None),
    camera_id: Optional[int] = Query(None),
    date_from: Optional[datetime] = Query(None, alias="from"),
    date_to: Optional[datetime] = Query(None, alias="to"),
    format: Optional[str] = Query(None),
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_permission("search_vehicles")),
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
        writer.writerow([
            _csv_safe(r["id"]), _csv_safe(r["plate_number"]), _csv_safe(r["camera_id"]),
            _csv_safe(r["detected_at"]), _csv_safe(r["confidence"]),
        ])
    return Response(content=buffer.getvalue(), media_type="text/csv")


@router.get("/density", response_model=list[DensityPoint])
def get_density(
    window_minutes: Optional[int] = Query(None, ge=1, le=180),
    hour: Optional[int] = Query(None, ge=0, le=23),
    on_date: Optional[date] = Query(None, alias="date"),
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_permission("view_analytics")),
):
    """Per-camera detection counts for the Map page's density layer -- see
    detections_service.camera_density_counts for the two supported windows."""
    resolved_date = _resolve_window(window_minutes, hour, on_date)
    dept = user.get("scope_value") if user.get("scope_type") == "district" else None
    results = detections_service.camera_density_counts(
        db, window_minutes=window_minutes, hour=hour, on_date=resolved_date, dept=dept
    )
    return [DensityPoint(**r).model_dump(mode="json") for r in results]


@router.get("/flows", response_model=list[CorridorFlow])
def get_flows(
    # Wider ceiling than /density's: a transition needs both its endpoints
    # inside the window, and MAX_FLOW_TRANSITION_GAP_HOURS allows a gap up
    # to 3 hours between them, so the window must comfortably exceed that
    # to ever see a near-max-gap transition in full.
    window_minutes: Optional[int] = Query(None, ge=1, le=360),
    hour: Optional[int] = Query(None, ge=0, le=23),
    on_date: Optional[date] = Query(None, alias="date"),
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_permission("view_analytics")),
):
    """Camera-to-camera transition volume and average speed for the Map
    page's Flow layer -- see detections_service.camera_flow_pairs for the
    two supported windows (same live/hour choice as GET /detections/density)."""
    resolved_date = _resolve_window(window_minutes, hour, on_date)
    dept = user.get("scope_value") if user.get("scope_type") == "district" else None
    results = detections_service.camera_flow_pairs(
        db, window_minutes=window_minutes, hour=hour, on_date=resolved_date, dept=dept
    )
    return [CorridorFlow(**r).model_dump(mode="json") for r in results]


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
