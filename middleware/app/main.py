import asyncio
import hmac
import json
import os
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .adapters import discover
from .models import Detection, Source
from .store import Store


def create_app(sources=None, db_path=None, admin_key=None, transport=None, poll_seconds=30):
    sources = sources if sources is not None else [Source.model_validate(s) for s in json.loads(Path(os.environ.get("FEDERATION_SOURCES", "sources.local.json")).read_text())]
    if len({s.id for s in sources}) != len(sources):
        raise ValueError("Source IDs must be unique")
    admin_key = admin_key or os.environ.get("FEDERATION_ADMIN_KEY", "")
    if len(admin_key) < 24:
        raise ValueError("FEDERATION_ADMIN_KEY must have at least 24 characters")
    keys = {s.id: os.environ.get(s.ingest_key_env, "") for s in sources}
    if any(len(k) < 24 for k in keys.values()) or len(set(keys.values()) | {admin_key}) != len(keys) + 1:
        raise ValueError("Set a unique ingest key of at least 24 characters for every source")
    path = Path(db_path or os.environ.get("FEDERATION_DB", "data/federation.sqlite3"))
    path.parent.mkdir(parents=True, exist_ok=True)
    store = Store(path)
    source_map = {s.id: s for s in sources}
    store.begin_session(source_map)
    refresh_lock = asyncio.Lock()

    async def refresh():
        async with refresh_lock:
            async def one(source):
                source_transport = transport or (httpx.AsyncHTTPTransport(local_address="0.0.0.0") if source.force_ipv4 else None)
                async with httpx.AsyncClient(timeout=15, transport=source_transport, follow_redirects=False, trust_env=False) as client:
                    try:
                        cameras = await discover(source, client)
                        store.sync(source.id, cameras)
                    except Exception:
                        # Do not return upstream URLs, credentials, or response bodies.
                        store.sync(source.id, error="Inventory unavailable or invalid; check source configuration and connectivity")
            await asyncio.gather(*(one(s) for s in sources))

    @asynccontextmanager
    async def lifespan(app):
        async def loop():
            while True:
                await refresh()
                await asyncio.sleep(poll_seconds)
        task = asyncio.create_task(loop())
        yield
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    app = FastAPI(title="DIGDRISHTI Federation", version="0.1.0", lifespan=lifespan)
    bearer = HTTPBearer(auto_error=False)

    def token(credentials: HTTPAuthorizationCredentials | None):
        return credentials.credentials if credentials else ""

    def admin(credentials=Depends(bearer)):
        if not hmac.compare_digest(token(credentials), admin_key):
            raise HTTPException(401, "Administrator credential required")

    @app.middleware("http")
    async def security(request: Request, call_next):
        if request.method == "POST":
            # Bound requests including chunked bodies before JSON parsing.
            size = 0
            chunks = []
            async for chunk in request.stream():
                size += len(chunk)
                if size > 16384:
                    from fastapi.responses import JSONResponse
                    return JSONResponse({"detail": "Request too large"}, status_code=413)
                chunks.append(chunk)
            request._body = b"".join(chunks)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.get("/", include_in_schema=False)
    def dashboard():
        return FileResponse(Path(__file__).with_name("dashboard.html"))

    @app.get("/health")
    def health():
        return {"status": "ok", "service": "DIGDRISHTI Federation", "scope": "service liveness; inspect /api/sources for upstream health"}

    @app.get("/api/sources", dependencies=[Depends(admin)])
    def list_sources():
        health = store.sources()
        return [{"id": s.id, "name": s.name, "adapter": s.adapter, "representative": s.representative,
                 **health.get(s.id, {"status": "initializing", "last_success": None})} for s in sources]

    @app.post("/api/sync", dependencies=[Depends(admin)])
    async def sync():
        await refresh()
        return list_sources()

    @app.get("/api/cameras", dependencies=[Depends(admin)])
    def cameras(source_id: str | None = None, limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
        items = store.cameras(source_map, limit, offset, source_id)
        states = store.sources()
        for item in items:
            item["stale"] = states.get(item["source_id"], {}).get("status") != "connected"
            if item["stale"]:
                item["status"] = "unknown"
        return {"items": items, "limit": limit, "offset": offset}

    @app.post("/api/sources/{source_id}/events")
    def ingest(source_id: str, event: Detection, credentials=Depends(bearer)):
        source = source_map.get(source_id)
        if source is None or not hmac.compare_digest(token(credentials), keys[source_id]):
            raise HTTPException(401, "Source credential required")
        try:
            recorded, duplicate = store.record(source, event)
        except LookupError as exc:
            raise HTTPException(422, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return {"event": recorded, "duplicate": duplicate}

    @app.get("/api/events", dependencies=[Depends(admin)])
    def events(plate: str | None = None, after: datetime | None = None, before: datetime | None = None,
               limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
        if (after and after.tzinfo is None) or (before and before.tzinfo is None):
            raise HTTPException(422, "Time filters require timezones")
        if after and before and after > before:
            raise HTTPException(422, "after must not exceed before")
        normalized = "".join(plate.upper().split()) if plate else None
        rows = store.events(source_map, limit, offset, normalized,
                            after.astimezone(timezone.utc).isoformat() if after else None,
                            before.astimezone(timezone.utc).isoformat() if before else None)
        return {"items": rows, "limit": limit, "offset": offset,
                "correlation": "Exact normalized plate matches; sightings are observations, not a verified continuous route"}

    return app
