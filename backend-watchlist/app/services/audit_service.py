"""Append-only audit log — insert/select only, never update or delete.

Duplicated (not shared) in backend-registry and backend-watchlist by design —
keeps each service independently owned with zero cross-folder edits.
"""
from psycopg2.extras import RealDictCursor


def log(db: RealDictCursor, user_id, action: str, resource_type: str, resource_id=None, reason_code=None):
    db.execute(
        """
        INSERT INTO audit_logs (user_id, action, resource_type, resource_id, badge_number, reason_code)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (user_id, action, resource_type, resource_id, user_id, reason_code),
    )


def history_for(db: RealDictCursor, resource_type: str, resource_id: int) -> list[dict]:
    """Every audit_logs row for one specific alert, oldest first -- the raw
    material for the alert detail panel's history strip. audit_logs is owned
    by backend-registry's schema, but read directly here rather than a cross-
    service HTTP call: both services already share one physical Postgres
    instance (see push_service's officers/postings joins for the same
    pattern), and this is a read-only, single-table query."""
    db.execute(
        """
        SELECT action, badge_number, timestamp, reason_code
        FROM audit_logs
        WHERE resource_type = %s AND resource_id = %s
        ORDER BY timestamp ASC
        """,
        (resource_type, resource_id),
    )
    return db.fetchall()
