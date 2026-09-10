"""Watchlist CRUD — officer access only. No SQL here; delegates to services/."""
from fastapi import APIRouter, Depends
from psycopg2.extras import RealDictCursor

from ..auth import require_role
from ..database import get_db
from ..logging_config import logger
from ..schemas import WatchlistCreate, WatchlistOut
from ..services import audit_service, watchlist_service

router = APIRouter(prefix="/watchlist", tags=["watchlist"])


@router.get("", response_model=list[WatchlistOut])
def get_watchlist(
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_role("officer")),
):
    return watchlist_service.list_watchlist(db)


@router.post("", response_model=WatchlistOut, status_code=201)
def add_watchlist_entry(
    entry: WatchlistCreate,
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_role("officer")),
):
    created = watchlist_service.create_watchlist_entry(db, entry)
    logger.info(f"watchlist entry added: {created['plate_number']} ({entry.priority} priority, flagged by {entry.dept_flagged})")
    actor = user.get("badge_number", user.get("sub"))
    audit_service.log(db, actor, "create", "watchlist", created["id"], reason_code=created["plate_number"])
    return created