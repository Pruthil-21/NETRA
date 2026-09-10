"""DIGDHRISHTI — backend-registry service entrypoint.

Route handlers live in routers/ (one file per resource area, mirroring
backend-watchlist's own convention) -- this file only wires the app
together: middleware, the federation proxy mount, and each router.

Run locally: uvicorn app.main:app --reload --port 8000
"""
import asyncio

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .auth import get_current_user, has_permission
from .db import get_conn
from .federation_proxy import build_router as build_federation_router
from .logging_config import configure_logging
from .services import recording_health_stream
from .routers import (
    admin_ops,
    audit_logs,
    auth,
    cameras,
    circles,
    coverage_targets,
    duties,
    notifications,
    police_stations,
    postings,
    recording_webhooks,
    registration_admin,
    reports,
    roles,
)

configure_logging()

app = FastAPI(title="DIGDHRISHTI Registry Service")

# Browser clients (frontend-dashboard, frontend-map) send an Authorization
# header cross-origin, which forces a CORS preflight (OPTIONS) -- without this,
# FastAPI has no route for OPTIONS and rejects it with 405 before the real
# request is ever sent.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# DIGDHRISHTI Federation (D:\middleware) camera-inventory proxy -- see
# federation_proxy.py's module docstring. Every /federation/* route goes
# through our own get_current_user/has_permission/get_conn, so the
# federation service's own admin credential (FEDERATION_SERVICE_KEY) stays
# server-side and never reaches the browser.
app.include_router(build_federation_router(get_current_user, has_permission, get_conn))

app.include_router(auth.router)
app.include_router(registration_admin.router)
app.include_router(postings.router)
app.include_router(notifications.router)
app.include_router(roles.router)
app.include_router(duties.router)
app.include_router(admin_ops.router)
app.include_router(cameras.router)
app.include_router(coverage_targets.router)
app.include_router(reports.router)
app.include_router(audit_logs.router)
app.include_router(police_stations.router)
app.include_router(circles.router)
app.include_router(recording_webhooks.router)


@app.on_event("startup")
async def _capture_recording_health_stream_loop():
    # broadcast_sync (called from the webhook's sync background task) needs
    # the running event loop to schedule the actual async send -- same
    # pattern as backend-watchlist's alerts_stream capture.
    recording_health_stream.manager.loop = asyncio.get_running_loop()


@app.get("/health")
def health():
    return {"status": "ok"}
