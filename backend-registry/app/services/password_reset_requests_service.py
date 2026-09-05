"""An officer's self-service request for a Super Admin to reset their
password -- read/write side for password_reset_requests. Deliberately never
touches a password value: the table tracks only who asked, why, and what the
reviewer decided. The actual new password is set separately, at approval
time, through admin_service's existing reset-password path."""


def create_request(conn, officer_id: int, reason: str | None) -> dict:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO password_reset_requests (officer_id, reason)
            VALUES (%s, %s)
            RETURNING id, officer_id, reason, status, requested_at, reviewed_by, reviewed_at
            """,
            (officer_id, reason),
        )
        row = cur.fetchone()
        conn.commit()
        cols = [c.name for c in cur.description]
        return dict(zip(cols, row))


def list_requests(conn, status: str | None = None) -> list[dict]:
    query = """
        SELECT r.id, r.officer_id, r.reason, r.status, r.requested_at, r.reviewed_by, r.reviewed_at,
               o.badge_number, o.name AS officer_name, o.rank,
               ro.name AS role_name, p.scope_type, p.scope_value
        FROM password_reset_requests r
        JOIN officers o ON o.id = r.officer_id
        LEFT JOIN postings p ON p.officer_id = o.id AND p.is_active
        LEFT JOIN roles ro ON ro.id = p.role_id
    """
    params: list = []
    if status is not None:
        query += " WHERE r.status = %s"
        params.append(status)
    query += " ORDER BY r.requested_at DESC"
    with conn.cursor() as cur:
        cur.execute(query, params)
        rows = cur.fetchall()
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in rows]


def get_request(conn, request_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, officer_id, reason, status, requested_at, reviewed_by, reviewed_at "
            "FROM password_reset_requests WHERE id = %s",
            (request_id,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        cols = [c.name for c in cur.description]
        return dict(zip(cols, row))


def mark_reviewed(conn, request_id: int, status: str, reviewed_by: str) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE password_reset_requests
            SET status = %s, reviewed_by = %s, reviewed_at = now()
            WHERE id = %s AND status = 'pending'
            RETURNING id, officer_id, reason, status, requested_at, reviewed_by, reviewed_at
            """,
            (status, reviewed_by, request_id),
        )
        row = cur.fetchone()
        conn.commit()
        if row is None:
            return None
        cols = [c.name for c in cur.description]
        return dict(zip(cols, row))
