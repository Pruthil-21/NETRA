"""NETRA — backend-watchlist service entrypoint.

Run locally: uvicorn app.main:app --reload --port 8001
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import alerts, detections, watchlist

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


@app.get("/health")
def health():
    return {"status": "ok"}
