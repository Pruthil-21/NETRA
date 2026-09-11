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
    # Self-commits -- same fix backend-registry's own audit_service.log
    # already has. database.py's get_connection() only commits if its
    # `with` block exits cleanly; every EXISTING call site here logs on a
    # success path right before a normal return, so that was never an
    # issue. The new access-denied guards (routers/alerts.py,
    # routers/traffic_alerts.py) log a denial and then deliberately raise
    # an HTTPException in the same request -- without this, that raise
    # would roll back the audit INSERT along with everything else,
    # silently discarding the exact record the denial guard exists to
    # create. An audit entry must survive regardless of what the rest of
    # the request does next.
    db.connection.commit()


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
