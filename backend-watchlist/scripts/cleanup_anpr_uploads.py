# backend-watchlist/scripts/cleanup_anpr_uploads.py
"""One-off/manual trigger for the same sweep app/main.py already runs on a
timer (see app/services/anpr_jobs_service.py's run_periodic_upload_cleanup).
Useful right after deploying this feature, or to force an immediate sweep
without waiting for the next scheduled tick. Idempotent -- safe to re-run,
already-cleaned jobs are simply skipped."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.config import settings
from app.database import get_connection
from app.services import anpr_jobs_service
from psycopg2.extras import RealDictCursor


def run():
    with get_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as db:
            deleted = anpr_jobs_service.cleanup_expired_uploads(db, settings.anpr_upload_retention_days)
    print(f"Deleted {deleted} expired anpr_jobs upload(s) older than {settings.anpr_upload_retention_days} days.")


if __name__ == "__main__":
    run()
