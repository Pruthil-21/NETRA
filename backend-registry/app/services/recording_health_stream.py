"""In-memory WebSocket connection registry for real-time recording-health
push -- same shape as backend-watchlist's alerts_stream.py, adapted for this
service's multi-posting district model (effective_district_scopes) instead
of a single scope_type/scope_value pair. Single-process demo deployment --
no cross-instance fan-out. The event loop is captured once at app startup
(see main.py) so broadcast_sync, called from sync route/service code, can
schedule the actual async send without blocking."""
import asyncio
import json

from fastapi import WebSocket

from ..logging_config import logger


class RecordingHealthConnectionManager:
    def __init__(self):
        self._connections: dict[WebSocket, list[str] | None] = {}
        self.loop: asyncio.AbstractEventLoop | None = None

    async def connect(self, websocket: WebSocket, dept_scopes: list[str] | None):
        await websocket.accept()
        # None = platform-wide (every event), [] = zero jurisdiction (no
        # event ever matches), a real list = only those districts' events --
        # same semantics as effective_district_scopes' own return contract.
        self._connections[websocket] = dept_scopes

    def disconnect(self, websocket: WebSocket):
        self._connections.pop(websocket, None)

    def _matches(self, dept_scopes: list[str] | None, camera_dept: str | None) -> bool:
        if dept_scopes is None:
            return True
        return camera_dept is not None and camera_dept in dept_scopes

    async def _broadcast_async(self, event: dict, camera_dept: str | None):
        dead = []
        for ws, dept_scopes in list(self._connections.items()):
            if not self._matches(dept_scopes, camera_dept):
                continue
            try:
                await ws.send_text(json.dumps(event))
            except Exception:  # noqa: BLE001 -- any send failure means this connection is dead; evict it regardless of cause
                logger.exception(f"recording-health broadcast send failed for connection scopes={dept_scopes}; evicting")
                dead.append(ws)
        for ws in dead:
            self._connections.pop(ws, None)
            try:
                await ws.close()
            except Exception as exc:  # noqa: BLE001 -- best-effort; a failure to close one dead connection must not block evicting the rest
                logger.debug(f"failed to close already-dead connection: {exc!r}")

    def broadcast_sync(self, event: dict, camera_dept: str | None) -> None:
        """Safe to call from sync code (the webhook route's background
        task). Best-effort: if the event loop hasn't been captured yet
        (e.g. app startup event never fired, as in a bare non-context-manager
        TestClient), this is a no-op rather than an error -- a missed
        broadcast is recoverable via the REST snapshot endpoint; raising
        here is not worth breaking event ingestion over."""
        if self.loop is None:
            return
        future = asyncio.run_coroutine_threadsafe(self._broadcast_async(event, camera_dept), self.loop)

        def _log_if_failed(fut: "asyncio.Future"):
            if not fut.cancelled() and fut.exception() is not None:
                logger.exception("recording-health broadcast coroutine raised", exc_info=fut.exception())

        future.add_done_callback(_log_if_failed)


manager = RecordingHealthConnectionManager()
