"""Recording-health real-time integration:
- Inbound webhook from the DIGDHRISHTI continuous-recording service
  (streaming/recording -- Dhruv's project), gated by a shared secret header
  (RECORDING_WEBHOOK_KEY), never a JWT -- it isn't officer traffic.
- Outbound WebSocket pushing those same events live to the frontend, gated
  by a real officer JWT and this officer's own district scope, same as
  backend-watchlist's /alerts/stream.

See services/recordings_service.py's module docstring for the outbound half
of the *other* integration direction (us calling the recording service's
own /list and /api/health)."""
import os

import jwt
from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Query, WebSocket, WebSocketDisconnect

from ..auth import _RBAC_ROLES
from ..config import settings
from ..db import get_conn
from ..logging_config import logger
from ..rbac_scope import effective_district_scopes
from ..schemas import RecordingHealthEventAccepted, RecordingHealthEventIn
from ..services import cameras_service, recording_health_events_service, recording_health_stream

router = APIRouter(prefix="/recordings", tags=["recording webhooks"])


@router.post("/health-events", response_model=RecordingHealthEventAccepted, status_code=202)
def receive_recording_health_event(
    body: RecordingHealthEventIn,
    background_tasks: BackgroundTasks,
    x_webhook_key: str | None = Header(default=None),
):
    expected_key = os.environ.get("RECORDING_WEBHOOK_KEY", "")
    # An unset key means this deployment hasn't turned the sink on yet --
    # reject every call rather than silently accepting unauthenticated
    # events the moment RECORDING_WEBHOOK_KEY happens to be blank.
    if not expected_key or x_webhook_key != expected_key:
        raise HTTPException(status_code=401, detail="Invalid or missing webhook key")

    def _write():
        # Same deliberate broad catch as receive_synthetic_detection in
        # routers/cameras.py: the 202 has already gone out, so a write
        # failure here can't be reported back to the caller -- this just
        # makes it observable instead of a silently dropped event.
        try:
            with get_conn() as conn:
                recording_health_events_service.record_event(
                    conn, body.event_id, body.path, body.status, body.message, body.occurred_at, body.payload
                )
                camera = cameras_service.get_camera_by_stream_id(conn, body.path)
            # Broadcast outside the connection's own transaction/scope --
            # a slow or dead websocket send must never hold a DB connection
            # open. A camera we don't recognize (path not yet mapped to a
            # registry camera) still gets persisted above, just never
            # broadcast live -- nothing to scope it to.
            if camera is not None:
                recording_health_stream.manager.broadcast_sync(
                    {
                        "event_id": body.event_id,
                        "camera_id": camera["id"],
                        "camera_name": camera["name"],
                        "stream_id": body.path,
                        "status": body.status,
                        "message": body.message,
                        "occurred_at": body.occurred_at,
                    },
                    camera["dept"],
                )
        except Exception:  # noqa: BLE001 -- deliberate catch-all, see comment above
            logger.error(f"failed to write recording health event {body.event_id}", exc_info=True)

    background_tasks.add_task(_write)
    return {"event_id": body.event_id, "status": "accepted"}


@router.websocket("/health-stream")
async def recording_health_stream_ws(websocket: WebSocket, token: str = Query(...)):
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        await websocket.close(code=4401)
        return

    # Same "is this an authenticated staff member" gate as require_role
    # applies to every other officer-facing route -- a role outside
    # officer/admin/the 5 RBAC role names must never reach the live feed
    # just because a WS route has no Depends() to hang a checker off of.
    role = payload.get("role")
    if role not in ("officer", "admin") and role not in _RBAC_ROLES:
        await websocket.close(code=4403)
        return

    dept_scopes = effective_district_scopes(payload)
    await recording_health_stream.manager.connect(websocket, dept_scopes)
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
        recording_health_stream.manager.disconnect(websocket)
