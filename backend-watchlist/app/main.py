"""NETRA — backend-watchlist service entrypoint.

Run locally: uvicorn app.main:app --reload --port 8001
"""
from fastapi import FastAPI

from .routers import watchlist

app = FastAPI(title="NETRA Watchlist & Alerts Service")

app.include_router(watchlist.router)


@app.get("/health")
def health():
    return {"status": "ok"}