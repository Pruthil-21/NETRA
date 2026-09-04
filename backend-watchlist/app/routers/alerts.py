"""Alerts — GET and PATCH are officer-only.

Alerts are created internally as a side effect of POST /detections (see
routers/detections.py), never posted here directly — a watchlist match is
detected and the alert row created in the same request that records the
underlying detection, so ml-anpr only ever calls one endpoint.
"""
import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from psycopg2.extras import RealDictCursor  # type: ignore

from ..auth import require_role
from ..config import settings
from ..database import get_db
from ..logging_config import logger
from ..schemas import AlertOut, AlertStatusUpdate
from ..services import alerts_service, alerts_stream, audit_service

router = APIRouter(prefix="/alerts", tags=["alerts"])


@router.get("", response_model=list[AlertOut])
def get_alerts(
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_role("officer")),
):
    return alerts_service.list_alerts(db)

@router.patch("/{alert_id}", response_model=AlertOut)
def update_alert_status(
    alert_id: int,
    body: AlertStatusUpdate,
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_role("officer")),
):
    actor = user.get("badge_number", user.get("sub"))

    if body.status == "ESCALATED" and alerts_service.has_prior_status_change(db, alert_id, actor):
        raise HTTPException(
            status_code=409,
            detail="Separation of duty: the officer who already acted on this alert cannot also escalate it",
        )

    alert = alerts_service.update_status(db, alert_id, body.status, actor)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    audit_service.log(db, actor, "status_change", "alert", alert_id, reason_code=body.reason_code)
    logger.info(f"alert {alert_id} status changed to {body.status} by {actor}")
    return alert


@router.websocket("/stream")
async def alerts_stream_ws(websocket: WebSocket, token: str = Query(...)):
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        await websocket.close(code=4401)
        return

    await alerts_stream.manager.connect(websocket, payload.get("scope_type", "platform"), payload.get("scope_value"))
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        alerts_stream.manager.disconnect(websocket)
