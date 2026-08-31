"""Append-only audit log — insert/select only, never update or delete.

Duplicated (not shared) in backend-registry and backend-watchlist by design —
keeps each service independently owned with zero cross-folder edits.
"""
from psycopg2.extras import RealDictCursor


def log(db: RealDictCursor, user_id, action: str, resource_type: str, resource_id=None):
    db.execute(
        """
        INSERT INTO audit_logs (user_id, action, resource_type, resource_id)
        VALUES (%s, %s, %s, %s)
        """,
        (user_id, action, resource_type, resource_id),
    )
