import contextlib
import uuid

import psycopg2
import psycopg2.extras
from app.config import settings


def _random_plate():
    return f"GJ01AB{uuid.uuid4().hex[:4].upper()}"


def _direct_conn():
    conn = psycopg2.connect(settings.database_url)
    conn.autocommit = True
    return conn


def test_adding_a_watchlist_entry_is_audited(client, officer_headers):
    plate = _random_plate()
    resp = client.post(
        "/watchlist",
        json={
            "plate_number": plate,
            "reason": "Audit trail test",
            "dept_flagged": "Traffic Police",
            "priority": "high",
        },
        headers=officer_headers,
    )
    assert resp.status_code == 201
    entry_id = resp.json()["id"]

    with contextlib.closing(_direct_conn()) as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT * FROM audit_logs WHERE resource_type = 'watchlist' AND resource_id = %s "
            "ORDER BY id DESC LIMIT 1",
            (entry_id,),
        )
        row = cur.fetchone()

    assert row is not None
    assert row["action"] == "create"
    # officer_headers mints a token with no badge_number claim, so the actor
    # falls back to `sub` -- same fallback every other router in this
    # codebase uses (user.get("badge_number", user.get("sub"))).
    assert row["user_id"] == "test-officer"
    assert row["badge_number"] == "test-officer"
    assert row["reason_code"] == plate
