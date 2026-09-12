"""Web Push subscription management -- an officer opts in once (see
frontend-map's profile page), and every alert-worthy event across both
services (watchlist match, congestion, camera-down, escalation) can then
reach their phone/desktop as a real OS notification, even with the app
closed. See services/push_service.py for the actual sending.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import get_current_user
from ..db import get_conn

router = APIRouter(prefix="/push", tags=["push"])


class PushSubscribeIn(BaseModel):
    """Matches the browser's own PushSubscription.toJSON() shape exactly --
    no reshaping needed client-side."""
    endpoint: str
    keys: dict


class PushUnsubscribeIn(BaseModel):
    endpoint: str


@router.post("/subscribe", status_code=204)
def subscribe(body: PushSubscribeIn, user=Depends(get_current_user)):
    badge_number = user.get("badge_number", user.get("sub"))
    if not badge_number:
        raise HTTPException(status_code=400, detail="This session has no badge number")
    p256dh = body.keys.get("p256dh")
    auth = body.keys.get("auth")
    if not p256dh or not auth:
        raise HTTPException(status_code=422, detail="Subscription is missing p256dh/auth keys")

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO push_subscriptions (badge_number, endpoint, p256dh_key, auth_key)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (badge_number, endpoint) DO UPDATE
                    SET p256dh_key = EXCLUDED.p256dh_key, auth_key = EXCLUDED.auth_key
                """,
                (badge_number, body.endpoint, p256dh, auth),
            )


@router.delete("/subscribe", status_code=204)
def unsubscribe(body: PushUnsubscribeIn, user=Depends(get_current_user)):
    badge_number = user.get("badge_number", user.get("sub"))
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM push_subscriptions WHERE badge_number = %s AND endpoint = %s",
                (badge_number, body.endpoint),
            )
