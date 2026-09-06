# backend-registry/app/services/admin_service.py
"""Business logic for the admin console: listing officers/postings and
reassigning postings (the only mutation -- role_name/scope on a posting
are never edited in place, see plan Global Constraints)."""


def list_officers(conn) -> list[dict]:
    """An officer can now hold several simultaneously-active postings (spec
    Section 3.3) -- fetching officers and their active postings as two
    separate queries (rather than one LEFT JOIN) avoids a row-per-posting
    fan-out that would otherwise duplicate an officer with 2+ active
    postings into 2+ rows here. active_posting (singular) stays for
    backward compatibility with callers that only ever showed one; the new
    active_postings (plural) is the full list."""
    with conn.cursor() as cur:
        cur.execute("SELECT id, badge_number, name, rank FROM officers ORDER BY badge_number")
        cols = [c.name for c in cur.description]
        officers = [dict(zip(cols, row)) for row in cur.fetchall()]

        cur.execute(
            """
            SELECT p.officer_id, p.id, r.name AS role_name, p.scope_type, p.scope_value
            FROM postings p JOIN roles r ON r.id = p.role_id
            WHERE p.is_active
            ORDER BY p.officer_id, p.created_at
            """
        )
        cols = [c.name for c in cur.description]
        posting_rows = [dict(zip(cols, row)) for row in cur.fetchall()]

    postings_by_officer: dict[int, list[dict]] = {}
    for row in posting_rows:
        postings_by_officer.setdefault(row["officer_id"], []).append({
            "id": row["id"], "role": row["role_name"],
            "scope_type": row["scope_type"], "scope_value": row["scope_value"],
        })

    result = []
    for officer in officers:
        active_postings = postings_by_officer.get(officer["id"], [])
        result.append({
            "id": officer["id"], "badge_number": officer["badge_number"],
            "name": officer["name"], "rank": officer["rank"],
            "active_posting": active_postings[0] if active_postings else None,
            "active_postings": active_postings,
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


def _get_posting(conn, posting_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT p.id, p.officer_id, r.name AS role, p.scope_type, p.scope_value, p.is_active
            FROM postings p JOIN roles r ON r.id = p.role_id WHERE p.id = %s
            """,
            (posting_id,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        cols = [c.name for c in cur.description]
        return dict(zip(cols, row))


def add_posting(
    conn, officer_id: int, role_id: int, scope_type: str, scope_value: str | None, assigned_by: str,
    expires_at=None,
) -> dict:
    """Adds a new active posting for this officer -- does NOT end any of
    their other active postings (spec Section 3.3: an officer can hold
    several simultaneously-active postings, e.g. Station Officer at Station
    A *and* Traffic Officer for a highway corridor). Ending a specific
    posting is a separate, explicit action -- see revoke_posting."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO postings (officer_id, role_id, scope_type, scope_value, assigned_by, expires_at)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (officer_id, role_id, scope_type, scope_value, assigned_by, expires_at),
        )
        posting_id = cur.fetchone()[0]
    conn.commit()
    return _get_posting(conn, posting_id)


def revoke_posting(conn, posting_id: int) -> dict | None:
    """Ends exactly this one posting, without touching any of the officer's
    other active postings (spec Section 3.3: "each individually revocable
    without touching the others"). Returns None when the posting doesn't
    exist or is already inactive -- the caller (main.py) turns that into a
    404, matching every other "not found" endpoint in this file."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE postings SET is_active = false, ended_at = now() WHERE id = %s AND is_active RETURNING id",
            (posting_id,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    conn.commit()
    return _get_posting(conn, posting_id)
