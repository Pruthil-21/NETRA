# backend-registry/app/services/notifications_service.py
"""Minimal in-app notification log (v2 spec, Phase D): role granted/revoked,
registration approved/rejected, an SoD conflict blocked an assignment.
Not email/SMS -- just what makes the approval queue and audit log feel
like one connected system instead of two disconnected features."""


def notify(conn, officer_id: int, type: str, message: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO notifications (officer_id, type, message) VALUES (%s, %s, %s)",
            (officer_id, type, message),
        )
    conn.commit()


def list_for_officer(conn, officer_id: int, unread_only: bool = False) -> list[dict]:
    with conn.cursor() as cur:
        if unread_only:
            cur.execute(
                "SELECT id, officer_id, type, message, read, created_at FROM notifications "
                "WHERE officer_id = %s AND NOT read ORDER BY created_at DESC",
                (officer_id,),
            )
        else:
            cur.execute(
                "SELECT id, officer_id, type, message, read, created_at FROM notifications "
                "WHERE officer_id = %s ORDER BY created_at DESC",
                (officer_id,),
            )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def mark_read(conn, officer_id: int, notification_id: int) -> bool:
    """Scoped to the requesting officer's own id -- an officer can only
    mark their own notifications read, never someone else's by guessing an id."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE notifications SET read = true WHERE id = %s AND officer_id = %s RETURNING id",
            (notification_id, officer_id),
        )
        return cur.fetchone() is not None


def mark_all_read(conn, officer_id: int) -> None:
    with conn.cursor() as cur:
        cur.execute("UPDATE notifications SET read = true WHERE officer_id = %s AND NOT read", (officer_id,))
    conn.commit()


def clear_all(conn, officer_id: int) -> None:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM notifications WHERE officer_id = %s", (officer_id,))
    conn.commit()
