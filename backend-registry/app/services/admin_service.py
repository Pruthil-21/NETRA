# backend-registry/app/services/admin_service.py
"""Business logic for the admin console: listing officers/postings and
reassigning postings (the only mutation -- role_name/scope on a posting
are never edited in place, see plan Global Constraints)."""
import asyncio

from ..config import settings
from ..db import get_conn
from ..logging_config import logger


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


def set_officer_status(conn, officer_id: int, status: str) -> bool:
    """Backs suspend/reactivate (spec Section 3.5/3.6). Never touches
    postings -- a suspended officer keeps their postings on record, they
    simply can't log in (see main.py's login handler) until reactivated."""
    with conn.cursor() as cur:
        cur.execute("UPDATE officers SET status = %s WHERE id = %s RETURNING id", (status, officer_id))
        found = cur.fetchone() is not None
    conn.commit()
    return found


def get_officer_profile(conn, officer_id: int) -> dict | None:
    """Full admin-facing profile (spec Section 3.4): identity, status,
    every active posting (not just one), and recent login history."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, badge_number, name, rank, photo_url, status, last_login_at FROM officers WHERE id = %s",
            (officer_id,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        cols = [c.name for c in cur.description]
        officer = dict(zip(cols, row))

        cur.execute(
            """
            SELECT p.id, r.name AS role, p.scope_type, p.scope_value
            FROM postings p JOIN roles r ON r.id = p.role_id
            WHERE p.officer_id = %s AND p.is_active ORDER BY p.created_at
            """,
            (officer_id,),
        )
        cols = [c.name for c in cur.description]
        officer["active_postings"] = [dict(zip(cols, r)) for r in cur.fetchall()]

        cur.execute(
            "SELECT timestamp FROM audit_logs WHERE action = 'login' AND resource_type = 'officer' "
            "AND resource_id = %s ORDER BY timestamp DESC LIMIT 10",
            (officer_id,),
        )
        officer["recent_logins"] = [r[0] for r in cur.fetchall()]
    return officer


def expire_stale_postings(conn) -> int:
    """Time-bound postings (spec Section 3.8, and the academic Temporal RBAC
    model -- Bertino/Bonatti/Ferrari, ACM TISSEC 2001 -- this is the simple,
    production-shaped version of that idea, not the full periodic-trigger
    machinery): a posting with an expires_at in the past auto-expires
    instead of staying is_active forever until someone remembers to revoke
    it. Auth-critical read paths (auth_service.get_active_postings) already
    filter on expires_at defensively -- this is what keeps is_active itself
    (and everything that lists postings without re-checking expires_at,
    like GET /admin/postings) honest too.

    Now run automatically (see main.py's periodic sweep loop, same shape as
    cameras_service.run_periodic_connectivity_sweep), not just by hand --
    scripts/expire_postings.py still works unchanged as a one-off/cron
    alternative. Every real expiry gets its own audit_logs row (actor
    "system", same convention cameras_service.update_camera uses for a
    connectivity transition nobody's browser actually triggered) so
    "why did this officer's access disappear" is always answerable from the
    audit trail, not silent."""
    from . import audit_service

    with conn.cursor() as cur:
        cur.execute(
            "UPDATE postings SET is_active = false, ended_at = now() "
            "WHERE is_active AND expires_at IS NOT NULL AND expires_at <= now() "
            "RETURNING id, officer_id, role_id"
        )
        expired_rows = cur.fetchall()
    conn.commit()

    for posting_id, officer_id, role_id in expired_rows:
        audit_service.log(
            conn, "system", "posting_auto_expired", "posting", posting_id,
            reason_code=f"officer_id={officer_id} role_id={role_id} -- expires_at reached",
        )
    return len(expired_rows)


async def run_periodic_posting_expiry_sweep() -> None:
    """Background task, one sweep every
    settings.posting_expiry_sweep_interval_seconds -- started from main.py's
    startup event, cancelled on shutdown, same shape as
    cameras_service.run_periodic_connectivity_sweep. Opens its own
    connection per tick (rather than holding one for the process lifetime)
    for the same reason that sweep does: a long-lived checked-out connection
    would sit idle in the pool between ticks, starving concurrent request
    handlers of a connection they actually need right now."""
    while True:
        try:
            with get_conn() as conn:
                expired = expire_stale_postings(conn)
                if expired:
                    logger.info(f"posting expiry sweep: auto-expired {expired} posting(s)")
        except Exception:  # noqa: BLE001 -- one bad tick must not kill the loop; see docstring above
            logger.exception("posting expiry sweep tick failed")
        await asyncio.sleep(settings.posting_expiry_sweep_interval_seconds)


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
