# backend-registry/app/services/sessions_service.py
"""Server-side session tracking, purely so an admin can force-logout an
officer before their JWT's natural expiry (spec Section 3.6). A session
with no matching row here (every token issued before this table existed,
and every hand-crafted test/demo token with no `sid` claim at all) is
always treated as valid -- see auth.get_current_user."""
import uuid


def create_session(conn, officer_id: int) -> str:
    session_id = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute("INSERT INTO sessions (id, officer_id) VALUES (%s, %s)", (session_id, officer_id))
    conn.commit()
    return session_id


def is_session_revoked(conn, session_id: str) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT revoked FROM sessions WHERE id = %s", (session_id,))
        row = cur.fetchone()
        return bool(row and row[0])


def revoke_all_sessions(conn, officer_id: int) -> int:
    """Force-logout: revokes every currently-active session this officer
    holds. Returns how many were actually revoked (0 if they had none)."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE sessions SET revoked = true WHERE officer_id = %s AND NOT revoked RETURNING id",
            (officer_id,),
        )
        return len(cur.fetchall())
