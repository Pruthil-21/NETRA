"""NETRA — backend-watchlist service entrypoint.

Run locally: uvicorn app.main:app --reload --port 8001
"""
from fastapi import FastAPI

from .routers import alerts, detections, watchlist

app = FastAPI(title="NETRA Watchlist & Alerts Service")

app.include_router(watchlist.router)
app.include_router(alerts.router)
app.include_router(detections.router)


@app.get("/health")
def health():
    return {"status": "ok"}
