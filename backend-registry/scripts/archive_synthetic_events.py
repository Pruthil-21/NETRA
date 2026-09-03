"""Moves synthetic_detection_events rows older than N days (default 30) into
synthetic_detection_events_archive. Run by hand, or wire into a cron/CI
schedule -- this script is the unit either would call.

    venv/Scripts/python.exe scripts/archive_synthetic_events.py
    venv/Scripts/python.exe scripts/archive_synthetic_events.py --days 7
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.db import get_conn
from app.services.synthetic_events_service import (
    archive_events_older_than,
)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=30)
    args = parser.parse_args()

    with get_conn() as conn:
        result = archive_events_older_than(conn, args.days)
    print(f"Archived {result['archived']} synthetic detection event(s) older than {args.days} days.")
