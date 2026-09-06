"""Auto-expires postings whose expires_at has passed (v2 spec Section 3.8:
time-bound/temporary postings). Run by hand, or wire into a cron/CI
schedule -- this script is the unit either would call.

    venv/Scripts/python.exe scripts/expire_postings.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.db import get_conn
from app.services.admin_service import expire_stale_postings

if __name__ == "__main__":
    with get_conn() as conn:
        expired = expire_stale_postings(conn)
    print(f"Expired {expired} stale posting(s).")
