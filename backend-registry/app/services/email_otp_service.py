"""OTP generation/verification for email 2FA and self-service password
reset (see schema.sql's email_otps table). code_hash stores a SHA-256 hash
of the 6-digit code, never the code itself -- same reasoning as
officers.password_hash, just a cheaper hash since these are short-lived,
single-use, rate-limited codes rather than a long-term credential.
"""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from . import email_service

OTP_LIFETIME = timedelta(minutes=10)
MAX_VERIFY_ATTEMPTS = 5


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


def _generate_code() -> str:
    # secrets.randbelow, not random.randint -- this code gates account
    # access, so it needs a cryptographically secure source same as any
    # other credential-adjacent value in this codebase (see
    # trusted_devices_service.generate_device_token).
    return f"{secrets.randbelow(1_000_000):06d}"


def request_otp(conn, officer_id: int, email: str, purpose: str) -> None:
    """Invalidates any still-pending OTP of this purpose for this officer
    (a resend shouldn't leave two valid codes outstanding), generates and
    stores a new one, and emails it. Raises email_service.EmailSendError if
    the send itself fails -- the caller decides how to surface that; the
    invalidation above still happened, so a failed send never leaves a
    stale valid code sitting around to be confused with a fresh resend."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE email_otps SET consumed_at = now() "
            "WHERE officer_id = %s AND purpose = %s AND consumed_at IS NULL",
            (officer_id, purpose),
        )
        code = _generate_code()
        cur.execute(
            "INSERT INTO email_otps (officer_id, purpose, code_hash, expires_at) VALUES (%s, %s, %s, %s)",
            (officer_id, purpose, _hash_code(code), datetime.now(timezone.utc) + OTP_LIFETIME),
        )
    conn.commit()
    email_service.send_otp_email(email, code, purpose)


def verify_otp(conn, officer_id: int, purpose: str, code: str) -> bool:
    """The latest not-yet-consumed OTP of this purpose for this officer must
    exist, not be expired, not have exceeded MAX_VERIFY_ATTEMPTS wrong
    guesses already, and match. A wrong guess increments attempt_count
    (checked BEFORE comparing the code, so an attacker can't burn through
    unlimited tries by always guessing wrong on an about-to-expire code) --
    a match marks it consumed so it can never be replayed."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, code_hash, expires_at, attempt_count FROM email_otps
            WHERE officer_id = %s AND purpose = %s AND consumed_at IS NULL
            ORDER BY created_at DESC LIMIT 1
            """,
            (officer_id, purpose),
        )
        row = cur.fetchone()
        if row is None:
            return False
        otp_id, code_hash, expires_at, attempt_count = row

        if attempt_count >= MAX_VERIFY_ATTEMPTS or expires_at < datetime.now(timezone.utc):
            return False

        cur.execute("UPDATE email_otps SET attempt_count = attempt_count + 1 WHERE id = %s", (otp_id,))

        # secrets.compare_digest -- constant-time, so a timing side-channel
        # can't be used to guess the code one character at a time.
        if not secrets.compare_digest(code_hash, _hash_code(code)):
            conn.commit()
            return False

        cur.execute("UPDATE email_otps SET consumed_at = now() WHERE id = %s", (otp_id,))
    conn.commit()
    return True
