# backend-registry/app/services/registration_service.py
"""Self-registration + pending-approvals queue (spec Section 3.2). The
officer row is created immediately at registration time, status='pending',
zero postings -- matches D365's "no role, no privileges" rule exactly (the
account exists and can log in, but has nothing). This table is the
admin-facing review queue and audit trail, not the account's source of
truth."""


def _row_to_dict(cur, row):
    if row is None:
        return None
    cols = [c.name for c in cur.description]
    return dict(zip(cols, row))


def get_pending_request_for_officer(conn, officer_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM registration_requests WHERE officer_id = %s AND status = 'pending'",
            (officer_id,),
        )
        return _row_to_dict(cur, cur.fetchone())


def create_request(conn, officer_id: int, department: str | None, contact_info: str | None) -> dict:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO registration_requests (officer_id, department, contact_info)
            VALUES (%s, %s, %s) RETURNING id
            """,
            (officer_id, department, contact_info),
        )
        request_id = cur.fetchone()[0]
    conn.commit()
    return get_request(conn, request_id)


def get_request(conn, request_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT rr.id, rr.officer_id, o.badge_number, o.name, o.rank,
                   rr.department, rr.contact_info, rr.status,
                   rr.reviewed_by, rr.reviewed_at, rr.rejection_reason, rr.created_at
            FROM registration_requests rr JOIN officers o ON o.id = rr.officer_id
            WHERE rr.id = %s
            """,
            (request_id,),
        )
        return _row_to_dict(cur, cur.fetchone())


def list_requests(conn, status: str | None = None) -> list[dict]:
    with conn.cursor() as cur:
        if status:
            cur.execute(
                """
                SELECT rr.id, rr.officer_id, o.badge_number, o.name, o.rank,
                       rr.department, rr.contact_info, rr.status,
                       rr.reviewed_by, rr.reviewed_at, rr.rejection_reason, rr.created_at
                FROM registration_requests rr JOIN officers o ON o.id = rr.officer_id
                WHERE rr.status = %s ORDER BY rr.created_at
                """,
                (status,),
            )
        else:
            cur.execute(
                """
                SELECT rr.id, rr.officer_id, o.badge_number, o.name, o.rank,
                       rr.department, rr.contact_info, rr.status,
                       rr.reviewed_by, rr.reviewed_at, rr.rejection_reason, rr.created_at
                FROM registration_requests rr JOIN officers o ON o.id = rr.officer_id
                ORDER BY rr.created_at
                """
            )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def mark_approved(conn, request_id: int, reviewed_by: str) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE registration_requests SET status = 'approved', reviewed_by = %s, reviewed_at = now()
            WHERE id = %s AND status = 'pending' RETURNING id
            """,
            (reviewed_by, request_id),
        )
        row = cur.fetchone()
    if row is None:
        return None
    conn.commit()
    return get_request(conn, request_id)


def mark_rejected(conn, request_id: int, reviewed_by: str, reason: str | None) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE registration_requests SET status = 'rejected', reviewed_by = %s, reviewed_at = now(),
                rejection_reason = %s
            WHERE id = %s AND status = 'pending' RETURNING id
            """,
            (reviewed_by, reason, request_id),
        )
        row = cur.fetchone()
    if row is None:
        return None
    conn.commit()
    return get_request(conn, request_id)
