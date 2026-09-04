"""In-memory WebSocket connection registry for real-time alert push.
Single-process demo deployment -- no cross-instance fan-out. The event loop
is captured once at app startup (see main.py) so broadcast_sync, called from
sync route/service code, can schedule the actual async send without blocking."""
import asyncio
import json

from fastapi import WebSocket

from ..logging_config import logger


def _json_default(value):
    """alert dicts come straight from a RealDictCursor row (see
    alerts_service.get_alert) -- matched_at is a real datetime, not the ISO
    string the HTTP JSON API produces via AlertOut's pydantic serialization.
    WebSocket.send_json has no hook for a custom encoder (plain json.dumps
    under the hood), so it can't handle that on its own -- hence dumping here
    with this as json.dumps's `default` and sending as text instead."""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


class AlertsConnectionManager:
    def __init__(self):
        self._connections: dict[WebSocket, dict] = {}
        self.loop: asyncio.AbstractEventLoop | None = None

    async def connect(self, websocket: WebSocket, scope_type: str, scope_value: str | None):
        await websocket.accept()
        self._connections[websocket] = {"scope_type": scope_type, "scope_value": scope_value}

    def disconnect(self, websocket: WebSocket):
        self._connections.pop(websocket, None)

    def _matches(self, scope: dict, camera_district: str | None) -> bool:
        if scope["scope_type"] == "platform":
            return True
        return scope["scope_type"] == "district" and scope["scope_value"] == camera_district

    async def _broadcast_async(self, alert: dict, camera_district: str | None):
        dead = []
        for ws, scope in list(self._connections.items()):
            if not self._matches(scope, camera_district):
                continue
            try:
                await ws.send_text(json.dumps(alert, default=_json_default))
            except Exception:
                logger.exception(f"alert broadcast send failed for connection scope={scope}; evicting")
                dead.append(ws)
        for ws in dead:
            self._connections.pop(ws, None)
            try:
                await ws.close()
            except Exception:
                # Best-effort -- a failure to close one dead connection must
                # not block evicting the rest.
                pass

    def broadcast_sync(self, alert: dict, camera_district: str | None) -> None:
        """Safe to call from sync code (e.g. alerts_service.process_detection,
        which runs in FastAPI's sync-route threadpool). Best-effort: if the
        event loop hasn't been captured yet (e.g. app startup event never
        fired, as in a bare non-context-manager TestClient), this is a no-op
        rather than an error -- a missed broadcast is recoverable via the
        existing 5s poll; raising here is not worth breaking detection
        recording over."""
        if self.loop is None:
            return
        future = asyncio.run_coroutine_threadsafe(self._broadcast_async(alert, camera_district), self.loop)

        def _log_if_failed(fut: "asyncio.Future"):
            # _broadcast_async's own try/except already handles per-send
            # failures -- this only catches a bug in the coroutine itself
            # (e.g. _matches raising), which would otherwise just log a
            # silent "exception was never retrieved" warning at GC time.
            if not fut.cancelled() and fut.exception() is not None:
                logger.exception("alert broadcast coroutine raised", exc_info=fut.exception())

        future.add_done_callback(_log_if_failed)


manager = AlertsConnectionManager()
