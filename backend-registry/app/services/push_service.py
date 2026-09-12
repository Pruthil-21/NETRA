"""Web Push delivery -- lets an alert reach an officer's phone/desktop as a
real OS-level notification even with the app closed, on top of the existing
in-app WebSocket + poll delivery.

Duplicated (not shared) in backend-registry and backend-watchlist by design,
same convention auth.py already follows in both -- each service triggers
push from its own alert-worthy events (camera-down here; watchlist/
congestion/escalation in backend-watchlist) against the one shared
push_subscriptions table (same Postgres instance, see schema.sql).
"""
import json

from pywebpush import WebPushException, webpush

from ..config import settings
from ..logging_config import logger


def recipients_for_scope(conn, district: str | None) -> list[str]:
    """badge_numbers of officers with an active posting that would see an
    alert in `district` -- platform-scoped postings always match; a
    district-scoped posting matches only that exact district. `district`
    of None (no camera/dept resolved) still returns every platform-scoped
    officer, never everyone unfiltered."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT o.badge_number
            FROM officers o
            JOIN postings p ON p.officer_id = o.id
            WHERE p.is_active
              AND (p.scope_type = 'platform' OR (p.scope_type = 'district' AND p.scope_value = %s))
            """,
            (district,),
        )
        return [row[0] for row in cur.fetchall()]


def send_to_badges(conn, badge_numbers: list[str], payload: dict) -> None:
    """Sends `payload` (expects title/body/url keys -- see sw.js's push
    handler) to every subscription on file for each badge_number. A
    subscription that comes back 410 Gone (expired/unsubscribed) is deleted
    so it's never retried; any other failure is logged and skipped -- one
    dead endpoint must never block delivery to the rest.

    No-ops (logs once, does nothing) when VAPID isn't configured, matching
    email_service's "opt-in feature, missing config degrades rather than
    crashes" posture -- a deployment that never sets up push simply never
    sends one, every other alert path (WS, poll) is completely unaffected."""
    if not settings.vapid_private_key or not badge_numbers:
        return

    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, badge_number, endpoint, p256dh_key, auth_key FROM push_subscriptions "
            "WHERE badge_number = ANY(%s)",
            (badge_numbers,),
        )
        subscriptions = cur.fetchall()

    dead_ids = []
    for sub_id, badge_number, endpoint, p256dh, auth in subscriptions:
        try:
            webpush(
                subscription_info={
                    "endpoint": endpoint,
                    "keys": {"p256dh": p256dh, "auth": auth},
                },
                data=json.dumps(payload),
                vapid_private_key=settings.vapid_private_key,
                vapid_claims={"sub": settings.vapid_subject},
            )
        except WebPushException as exc:
            status = exc.response.status_code if exc.response is not None else None
            if status == 410:
                dead_ids.append(sub_id)
            else:
                logger.warning(f"push delivery failed for badge {badge_number}: {exc}")

    if dead_ids:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM push_subscriptions WHERE id = ANY(%s)", (dead_ids,))
