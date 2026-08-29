"""Watchlist CRUD — officer access only. No SQL here; delegates to services/."""
from fastapi import APIRouter, Depends
from psycopg2.extras import RealDictCursor

from ..auth import require_role
from ..database import get_db
from ..schemas import WatchlistCreate, WatchlistOut
from ..services import watchlist_service

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
    return watchlist_service.create_watchlist_entry(db, entry)