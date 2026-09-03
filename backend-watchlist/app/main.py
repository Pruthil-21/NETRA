from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .logging_config import configure_logging
from .routers import alerts, detections, watchlist

configure_logging()

app = FastAPI(title="NETRA Watchlist & Alerts Service")

# Browser clients (frontend-dashboard, frontend-map) send an Authorization
# header (same as backend-registry; see that service's docstring). This
# service validates it in `get_current_user()` and `require_role()`, same
# pattern.

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(watchlist.router, prefix="/watchlist", tags=["watchlist"])
app.include_router(detections.router, prefix="/detections", tags=["detections"])
app.include_router(alerts.router, prefix="/alerts", tags=["alerts"])


@app.get("/health")
def health():
    return {"status": "ok"}
