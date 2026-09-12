"""DIGDHRISHTI — backend-watchlist service entrypoint.

Run locally: uvicorn app.main:app --reload --port 8001
"""
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .logging_config import configure_logging
from .routers import (
    alerts,
    detections,
    license_lookup,
    traces,
    traffic_alerts,
    vehicle_lookup,
    watchlist,
)
from .services import alerts_stream, traffic_alerts_service

configure_logging()

app = FastAPI(title="DIGDHRISHTI Watchlist & Alerts Service")


@app.on_event("startup")
async def _capture_alerts_stream_loop():
    import asyncio
    alerts_stream.manager.loop = asyncio.get_running_loop()


@app.on_event("startup")
async def _start_traffic_alert_evaluation_loop():
    import asyncio

    # pytest sets this for the duration of every test. Skipping the real,
    # DB-writing background loop under it matters here specifically because
    # every one of this suite's ~90 tests opens its own `with
    # TestClient(app)` context (see conftest.py's `client` fixture), each
    # firing this same startup event -- left unguarded, that's ~90
    # concurrent evaluation ticks racing every other test's monkeypatched
    # settings and writing real rows into the shared dev DB (see the
    # traffic_alerts_service tests, which call evaluate_and_broadcast
    # directly instead, for the actual behavior coverage).
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return
    app.state.traffic_alert_task = asyncio.create_task(traffic_alerts_service.run_periodic_evaluation())


@app.on_event("shutdown")
async def _stop_traffic_alert_evaluation_loop():
    task = getattr(app.state, "traffic_alert_task", None)
    if task is not None:
        task.cancel()

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
app.include_router(traffic_alerts.router)
app.include_router(detections.router)
app.include_router(traces.router)
app.include_router(vehicle_lookup.router)
app.include_router(license_lookup.router)


@app.get("/health")
def health():
    return {"status": "ok"}
