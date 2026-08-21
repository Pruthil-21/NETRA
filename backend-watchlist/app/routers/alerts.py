"""Alerts — GET is officer-only; POST is called internally by ml-anpr on every detection."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from psycopg2.extras import RealDictCursor

from ..auth import require_internal_key, require_role
from ..database import get_db
from ..schemas import AlertOut, AlertStatusUpdate, DetectionIn
from ..services import alerts_service

router = APIRouter(prefix="/alerts", tags=["alerts"])


@router.get("", response_model=list[AlertOut])
def get_alerts(
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_role("officer")),
):
    return alerts_service.list_alerts(db)


@router.post("", response_model=Optional[AlertOut], status_code=201)
def receive_detection(
    detection: DetectionIn,
    response: Response,
    db: RealDictCursor = Depends(get_db),
    _=Depends(require_internal_key),
):
    """ml-anpr posts every plate read here; only watchlist matches create an alert."""
    alert = alerts_service.process_detection(db, detection)
    if alert is None:
        response.status_code = 204
        return None
    return alert


@router.patch("/{alert_id}", response_model=AlertOut)
def update_alert_status(
    alert_id: int,
    body: AlertStatusUpdate,
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_role("officer")),
):
    alert = alerts_service.update_status(db, alert_id, body.status)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    return alert
