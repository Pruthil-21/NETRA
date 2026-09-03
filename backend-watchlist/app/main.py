"""NETRA — backend-watchlist service entrypoint.

Run locally: uvicorn app.main:app --reload --port 8001
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .logging_config import configure_logging
from .routers import (
    alerts,
    detections,
    license_lookup,
    traces,
    vehicle_lookup,
    watchlist,
)

configure_logging()

app = FastAPI(title="NETRA Watchlist & Alerts Service")

# Browser clients (frontend-dashboard, frontend-map) send an Authorization
# header cross-origin, which forces a CORS preflight (OPTIONS) — without this,
# FastAPI has no route for OPTIONS and rejects it with 405 before the real
# request is ever sent.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(watchlist.router)
app.include_router(alerts.router)
app.include_router(detections.router)
app.include_router(traces.router)
app.include_router(vehicle_lookup.router)
app.include_router(license_lookup.router)


@app.get("/health")
def health():
    return {"status": "ok"}
