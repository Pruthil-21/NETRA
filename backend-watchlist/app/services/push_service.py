"""Web Push delivery -- lets an alert reach an officer's phone/desktop as a
real OS-level notification even with the app closed, on top of the existing
in-app WebSocket + poll delivery (see alerts_stream.py).

Duplicated (not shared) in backend-registry and backend-watchlist by design,
same convention auth.py already follows in both -- each service triggers
push from its own alert-worthy events (watchlist/congestion/escalation
here; camera-down in backend-registry) against the one shared
push_subscriptions table (same Postgres instance, see schema.sql).
officers/postings are backend-registry-owned tables, queried here directly
by name -- same cross-service-same-DB pattern detections_service.py already
uses for `cameras`.
"""
import json

from psycopg2.extras import RealDictCursor
from pywebpush import WebPushException, webpush

from ..config import settings
from ..logging_config import logger


def recipients_for_scope(db: RealDictCursor, district: str | None) -> list[str]:
    """badge_numbers of officers with an active posting that would see an
    alert in `district` -- platform-scoped postings always match; a
    district-scoped posting matches only that exact district."""
    db.execute(
        """
        SELECT DISTINCT o.badge_number
        FROM officers o
        JOIN postings p ON p.officer_id = o.id
        WHERE p.is_active
          AND (p.scope_type = 'platform' OR (p.scope_type = 'district' AND p.scope_value = %s))
        """,
        (district,),
    )
    return [row["badge_number"] for row in db.fetchall()]


def send_to_badges(db: RealDictCursor, badge_numbers: list[str], payload: dict) -> None:
    """Sends `payload` (expects title/body/url keys -- see sw.js's push
    handler) to every subscription on file for each badge_number. A
    subscription that comes back 410 Gone (expired/unsubscribed) is deleted
    so it's never retried; any other failure is logged and skipped -- one
    dead endpoint must never block delivery to the rest.

    No-ops when VAPID isn't configured -- a deployment that never sets up
    push simply never sends one, every other alert path (WS, poll) is
    completely unaffected."""
    if not settings.vapid_private_key or not badge_numbers:
        return

    db.execute(
        "SELECT id, badge_number, endpoint, p256dh_key, auth_key FROM push_subscriptions "
        "WHERE badge_number = ANY(%s)",
        (badge_numbers,),
    )
    subscriptions = db.fetchall()

    dead_ids = []
    for sub in subscriptions:
        try:
            webpush(
                subscription_info={
                    "endpoint": sub["endpoint"],
                    "keys": {"p256dh": sub["p256dh_key"], "auth": sub["auth_key"]},
                },
                data=json.dumps(payload),
                vapid_private_key=settings.vapid_private_key,
                vapid_claims={"sub": settings.vapid_subject},
            )
        except WebPushException as exc:
            status = exc.response.status_code if exc.response is not None else None
            if status == 410:
                dead_ids.append(sub["id"])
            else:
                logger.warning(f"push delivery failed for badge {sub['badge_number']}: {exc}")

    if dead_ids:
        db.execute("DELETE FROM push_subscriptions WHERE id = ANY(%s)", (dead_ids,))
