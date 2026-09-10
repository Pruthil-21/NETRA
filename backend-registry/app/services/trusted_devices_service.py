"""'Remember this device' for login 2FA -- a long random token a trusted
browser presents on a future login to skip the OTP step. Only the token's
hash is ever stored (see schema.sql's trusted_devices table), same
reasoning as officers.password_hash: the raw token exists only in the
response body handed to the client and whatever the client chooses to store
it in (localStorage), never in this database.
"""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

DEVICE_TOKEN_LIFETIME = timedelta(days=30)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def generate_device_token() -> str:
    return secrets.token_urlsafe(32)


def register_device(conn, officer_id: int, token: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO trusted_devices (officer_id, device_token_hash, expires_at) VALUES (%s, %s, %s)",
            (officer_id, _hash_token(token), datetime.now(timezone.utc) + DEVICE_TOKEN_LIFETIME),
        )
    conn.commit()


def is_trusted(conn, officer_id: int, token: str) -> bool:
    """True only for a token that was actually registered to THIS officer
    and hasn't expired -- a token from someone else's device (or a stale
    localStorage value from before a badge number was reassigned/reused)
    never lets a login skip its OTP."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM trusted_devices WHERE officer_id = %s AND device_token_hash = %s AND expires_at > now()",
            (officer_id, _hash_token(token)),
        )
        row = cur.fetchone()
        if row is None:
            return False
        cur.execute("UPDATE trusted_devices SET last_used_at = now() WHERE id = %s", (row[0],))
    conn.commit()
    return True
