"""Alerts — GET and PATCH are officer-only.

Alerts are created internally as a side effect of POST /detections (see
routers/detections.py), never posted here directly — a watchlist match is
detected and the alert row created in the same request that records the
underlying detection, so ml-anpr only ever calls one endpoint.
"""
import jwt
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
)
from psycopg2.extras import RealDictCursor  # type: ignore

from ..auth import _RBAC_ROLES, require_permission, require_role
from ..config import settings
from ..database import get_db
from ..logging_config import logger
from ..rbac_scope import effective_district_scopes
from ..schemas import AlertHistoryEntry, AlertOut, AlertStatusUpdate
from ..services import alerts_service, alerts_stream, audit_service, push_service

router = APIRouter(prefix="/alerts", tags=["alerts"])


def _require_alert_in_scope(db, alert_id: int, user: dict, *, audit_denial: bool = False) -> dict:
    """404 for an alert that doesn't exist, 403 for one outside the
    officer's own jurisdiction -- same shape as backend-registry's
    _require_camera_in_scope. "In scope" is the dual rule list_alerts
    already applies: the detecting camera's district OR the watchlist
    entry's flagging district must be one of the officer's own.
    audit_denial=True (used before a status-changing PATCH) also logs the
    denied attempt, same AccessDenied convention as the entity-CRUD guards."""
    alert = alerts_service.get_alert(db, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    dept_scopes = effective_district_scopes(user)
    if dept_scopes is None:
        return alert
    in_scope = alert.get("camera_district") in dept_scopes or alert.get("flagged_district") in dept_scopes
    if not in_scope:
        if audit_denial:
            audit_service.log(
                db, user.get("badge_number", user.get("sub")), "access_denied_scope", "alert", alert_id,
                reason_code=(
                    f"camera in {alert.get('camera_district')}, flagged by {alert.get('flagged_district')}, "
                    f"scoped to {', '.join(dept_scopes) or 'none'}"
                ),
            )
        raise HTTPException(status_code=403, detail="Alert outside your jurisdiction")
    return alert


@router.get("", response_model=list[AlertOut])
def get_alerts(
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_role("officer")),
):
    return alerts_service.list_alerts(db, effective_district_scopes(user))

@router.patch("/{alert_id}", response_model=AlertOut)
def update_alert_status(
    alert_id: int,
    body: AlertStatusUpdate,
    db: RealDictCursor = Depends(get_db),
    # acknowledge_alerts, not require_role("officer") -- being staff (any
    # RBAC role, including auditor) is not the same as being allowed to
    # change an alert's status. Mirrors traffic_alerts.py's identical PATCH
    # gate; require_permission's own legacy-token bypass keeps every
    # pre-RBAC officer/admin fixture working unchanged.
    user=Depends(require_permission("acknowledge_alerts")),
):
    actor = user.get("badge_number", user.get("sub"))
    _require_alert_in_scope(db, alert_id, user, audit_denial=True)

    if body.status == "ESCALATED" and alerts_service.has_prior_status_change(db, alert_id, actor):
        raise HTTPException(
            status_code=409,
            detail="Separation of duty: the officer who already acted on this alert cannot also escalate it",
        )

    alert = alerts_service.update_status(db, alert_id, body.status, actor)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    audit_service.log(db, actor, f"alert_{body.status.lower()}", "alert", alert_id, reason_code=body.reason_code)
    logger.info(f"alert {alert_id} status changed to {body.status} by {actor}")

    if body.status == "ESCALATED":
        # Every officer scoped to see this alert, not just one named
        # assignee -- there's no "escalate to a specific officer" concept
        # in the alert model today (AlertStatusUpdate is just a status
        # enum), so this reuses the same dual detecting/flagging-district
        # scoping GET/PATCH /alerts already applies (alert already carries
        # both from update_status -> get_alert, no extra camera query
        # needed) rather than inventing new assignment UI.
        push_service.send_to_badges(
            db, push_service.recipients_for_scope(db, [alert.get("camera_district"), alert.get("flagged_district")]),
            {
                "title": "Alert escalated",
                "body": f"{alert['plate_number']} escalated by {actor}",
                "url": f"/alerts/track/{alert['plate_number']}",
            },
        )

    return alert


@router.get("/{alert_id}/history", response_model=list[AlertHistoryEntry])
def get_alert_history(
    alert_id: int,
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_role("officer")),
):
    _require_alert_in_scope(db, alert_id, user)
    return audit_service.history_for(db, "alert", alert_id)


@router.websocket("/stream")
async def alerts_stream_ws(websocket: WebSocket, token: str = Query(...)):
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        await websocket.close(code=4401)
        return

    # Same "staff member" gate as require_role("officer") on every other
    # alert-reading route -- a role outside officer/admin/the 5 RBAC role
    # names must never reach the live feed just because the WS route has no
    # Depends() to hang a checker off of.
    role = payload.get("role")
    if role not in ("officer", "admin") and role not in _RBAC_ROLES:
        await websocket.close(code=4403)
        return

    # A legacy token (no `scopes` claim -- every hand-crafted test/demo
    # token) still needs an explicit scope_type: unknown/missing is
    # rejected, never defaulted to "platform" (fails open to every
    # district's alerts) or guessed as district-scoped-with-no-district.
    # A real multi-posting token (a `scopes` claim present) skips this
    # specific legacy check -- its jurisdiction comes from that claim, not
    # a top-level scope_type, and is resolved below exactly the way every
    # REST alert endpoint already does.
    if payload.get("scopes") is None and payload.get("scope_type") not in ("platform", "district"):
        await websocket.close(code=4403)
        return

    # rbac_scope.effective_district_scopes is the same function every REST
    # alert endpoint resolves scope through -- previously this route only
    # ever read the single legacy scope_type/scope_value pair directly off
    # the token, so a multi-posting officer's `scopes` claim was silently
    # ignored and the live feed would never match every district they're
    # actually posted to. Reusing it here means this connection sees
    # exactly what GET /alerts would show that officer.
    districts = effective_district_scopes(payload)
    await alerts_stream.manager.connect(websocket, districts)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        # Runs on every exit path, not just a clean WebSocketDisconnect --
        # a CancelledError from server shutdown or Starlette's "cannot call
        # receive after disconnect" RuntimeError must not leak the
        # connection in the manager's registry forever.
        alerts_stream.manager.disconnect(websocket)
