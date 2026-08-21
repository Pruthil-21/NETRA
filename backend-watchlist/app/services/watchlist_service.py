"""Business logic for watchlist entries. Routers call this — never SQL directly."""
from psycopg2.extras import RealDictCursor

from ..schemas import WatchlistCreate


def list_watchlist(db: RealDictCursor):
    db.execute("SELECT * FROM watchlist ORDER BY date_added DESC")
    return db.fetchall()


def create_watchlist_entry(db: RealDictCursor, entry: WatchlistCreate):
    db.execute(
        """
        INSERT INTO watchlist (plate_number, reason, dept_flagged, priority)
        VALUES (%s, %s, %s, %s)
        RETURNING *
        """,
        (entry.plate_number, entry.reason, entry.dept_flagged, entry.priority),
    )
    return db.fetchone()


def find_by_plate(db: RealDictCursor, plate_number: str):
    db.execute("SELECT * FROM watchlist WHERE plate_number = %s", (plate_number,))
    return db.fetchone()