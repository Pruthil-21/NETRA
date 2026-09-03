# backend-registry/app/services/admin_service.py
"""Business logic for the admin console: listing officers/postings and
reassigning postings (the only mutation -- role_name/scope on a posting
are never edited in place, see plan Global Constraints)."""


def list_officers(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT o.id, o.badge_number, o.name, o.rank,
                   p.id AS posting_id, r.name AS role_name, p.scope_type, p.scope_value
            FROM officers o
            LEFT JOIN postings p ON p.officer_id = o.id AND p.is_active
            LEFT JOIN roles r ON r.id = p.role_id
            ORDER BY o.badge_number
            """
        )
        cols = [c.name for c in cur.description]
        rows = [dict(zip(cols, row)) for row in cur.fetchall()]

    result = []
    for row in rows:
        active_posting = None
        if row["posting_id"] is not None:
            active_posting = {
                "id": row["posting_id"], "role": row["role_name"],
                "scope_type": row["scope_type"], "scope_value": row["scope_value"],
            }
        result.append({
            "id": row["id"], "badge_number": row["badge_number"],
            "name": row["name"], "rank": row["rank"], "active_posting": active_posting,
        })
    return result


def list_postings(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT p.id, p.officer_id, r.name AS role, p.scope_type, p.scope_value, p.is_active
            FROM postings p
            JOIN roles r ON r.id = p.role_id
            ORDER BY p.officer_id, p.created_at DESC
            """
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def reassign_posting(conn, officer_id: int, role_id: int, scope_type: str, scope_value: str | None, assigned_by: str) -> dict:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE postings SET is_active = false, ended_at = now() WHERE officer_id = %s AND is_active",
            (officer_id,),
        )
        cur.execute(
            """
            INSERT INTO postings (officer_id, role_id, scope_type, scope_value, assigned_by)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
            """,
            (officer_id, role_id, scope_type, scope_value, assigned_by),
        )
        posting_id = cur.fetchone()[0]
    conn.commit()

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT p.id, p.officer_id, r.name AS role, p.scope_type, p.scope_value, p.is_active
            FROM postings p JOIN roles r ON r.id = p.role_id WHERE p.id = %s
            """,
            (posting_id,),
        )
        cols = [c.name for c in cur.description]
        return dict(zip(cols, cur.fetchone()))
