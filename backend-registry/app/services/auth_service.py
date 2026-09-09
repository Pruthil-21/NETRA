# backend-registry/app/services/auth_service.py
"""Password hashing and JWT issuance for real officer login (as opposed to
the hand-crafted test/demo JWTs used elsewhere in this codebase)."""
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from ..config import settings
from . import rbac_service, sessions_service

# Precomputed bcrypt hash of a fixed dummy value -- used when no officer
# matches the submitted badge number, so verify_password() still runs and
# the response time doesn't leak whether the badge number exists.
DUMMY_PASSWORD_HASH = bcrypt.hashpw(b"dummy-password-for-constant-time-login", bcrypt.gensalt()).decode("utf-8")

TOKEN_LIFETIME = timedelta(hours=12)

# Deliberately much shorter than TOKEN_LIFETIME -- this token proves nothing
# except "badge_number+password already checked out for officer N," and only
# to POST /auth/verify-login-otp, in the narrow window while that officer is
# expected to be reading the code out of their inbox. It is NOT a session
# token (get_current_user never accepts one -- see PENDING_LOGIN_PURPOSE
# below) and carries no permissions/scopes at all.
PENDING_LOGIN_TOKEN_LIFETIME = timedelta(minutes=10)
PENDING_LOGIN_PURPOSE = "pending_login_otp"

# Same shape as the pending-login token above, for the other place this
# codebase needs "prove you did step 1, before I'll act on step 2 without
# asking again": verifying a NEW email address before it's actually written
# to officers.email. The candidate email travels inside the token itself
# (not written to the database yet) so an abandoned/expired verification
# never leaves a half-changed email on the officer row.
PENDING_EMAIL_VERIFICATION_TOKEN_LIFETIME = timedelta(minutes=10)
PENDING_EMAIL_VERIFICATION_PURPOSE = "pending_email_verification"

# Account lockout policy (spec Section 3.6): N consecutive failed logins
# locks the account for a fixed cooldown. An admin can also unlock it early
# (see unlock_officer) rather than waiting out the cooldown.
MAX_FAILED_LOGIN_ATTEMPTS = 5
LOCKOUT_DURATION = timedelta(minutes=15)


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


_OFFICER_COLUMNS = (
    "id, badge_number, name, rank, password_hash, photo_url, email, "
    "status, last_login_at, failed_login_count, locked_until"
)


def get_officer_by_badge(conn, badge_number: str) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_OFFICER_COLUMNS} FROM officers WHERE badge_number = %s", (badge_number,))
        row = cur.fetchone()
        if row is None:
            return None
        cols = [c.name for c in cur.description]
        return dict(zip(cols, row))


def get_officer_by_id(conn, officer_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_OFFICER_COLUMNS} FROM officers WHERE id = %s", (officer_id,))
        row = cur.fetchone()
        if row is None:
            return None
        cols = [c.name for c in cur.description]
        return dict(zip(cols, row))


def is_locked(officer: dict) -> bool:
    locked_until = officer.get("locked_until")
    return locked_until is not None and locked_until > datetime.now(timezone.utc)


def record_failed_login(conn, officer_id: int) -> None:
    """Increments the counter and, on hitting the threshold, locks the
    account for LOCKOUT_DURATION. Runs only when the officer row actually
    exists (an unknown badge number has nothing to increment) -- the
    constant-time DUMMY_PASSWORD_HASH check the caller already does is
    what keeps an unknown-badge response indistinguishable from a wrong-
    password one; this function is orthogonal to that."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE officers SET failed_login_count = failed_login_count + 1,
                locked_until = CASE
                    WHEN failed_login_count + 1 >= %s THEN now() + %s
                    ELSE locked_until
                END
            WHERE id = %s
            """,
            (MAX_FAILED_LOGIN_ATTEMPTS, LOCKOUT_DURATION, officer_id),
        )
    conn.commit()


def record_successful_login(conn, officer_id: int) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE officers SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = %s",
            (officer_id,),
        )
    conn.commit()


def unlock_officer(conn, officer_id: int) -> None:
    """Admin override: clears a lockout before its cooldown naturally
    expires (spec Section 3.6)."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE officers SET failed_login_count = 0, locked_until = NULL WHERE id = %s", (officer_id,)
        )
    conn.commit()


def get_last_login(conn, officer_id: int):
    """Reuses the existing append-only audit_logs table (every successful
    login already writes a "login"/"officer" row there) rather than adding a
    redundant last_login column that would need its own write path."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT MAX(timestamp) FROM audit_logs WHERE action = 'login' AND resource_type = 'officer' AND resource_id = %s",
            (officer_id,),
        )
        return cur.fetchone()[0]


def set_password(conn, officer_id: int, new_password_hash: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE officers SET password_hash = %s WHERE id = %s",
            (new_password_hash, officer_id),
        )
        conn.commit()


def set_email(conn, officer_id: int, email: str | None) -> None:
    """Setting/clearing officers.email is what turns login 2FA and
    self-service password reset on/off for this officer -- both are inert
    for any officer whose email is NULL (see login()'s and
    request_password_reset()'s own checks in main.py)."""
    with conn.cursor() as cur:
        cur.execute("UPDATE officers SET email = %s WHERE id = %s", (email, officer_id))
        conn.commit()


def set_photo_url(conn, officer_id: int, photo_url: str | None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE officers SET photo_url = %s WHERE id = %s",
            (photo_url, officer_id),
        )
        conn.commit()


def get_active_postings(conn, officer_id: int) -> list[dict]:
    """Every currently-active, non-expired posting this officer holds
    (spec Section 3.3: an officer can hold several at once). Ordered by
    creation so callers that need "the primary one" for backward-compat
    single-scope display can just take index 0."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT p.id, p.role_id, p.scope_type, p.scope_value, r.name AS role_name
            FROM postings p
            JOIN roles r ON r.id = p.role_id
            WHERE p.officer_id = %s AND p.is_active AND (p.expires_at IS NULL OR p.expires_at > now())
            ORDER BY p.created_at
            """,
            (officer_id,),
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def issue_token(conn, officer: dict, postings: list[dict]) -> str:
    """Builds a token from every simultaneously-active posting an officer
    holds (spec Section 3.3's "sum total access" rule): permissions are the
    union of each posting's role's effective permissions (direct
    role_permissions plus every assigned duty's), deduplicated. `postings`
    may be empty (a 'pending' officer with zero postings yet, or one whose
    every posting has been revoked) -- that's a valid, "no role, no
    privileges" token, not an error; the caller decides whether login is
    otherwise allowed (account status, lockout).

    scope_type/scope_value (singular) stay for every existing caller that
    only ever read one scope -- a platform-wide posting wins that slot if
    the officer holds one (a Super Admin who *also* holds a district
    posting must still show as platform-wide there), otherwise the first
    posting by creation order. `scopes` (plural, deduplicated) is the full
    set, for callers that need real multi-jurisdiction union (see main.py's
    _effective_district_scopes)."""
    permission_set: set[str] = set()
    for posting in postings:
        permission_set.update(rbac_service.effective_role_permissions(conn, posting["role_id"]))

    primary = next((p for p in postings if p["scope_type"] == "platform"), postings[0] if postings else None)

    seen_scopes = set()
    scopes = []
    for p in postings:
        key = (p["scope_type"], p["scope_value"])
        if key in seen_scopes:
            continue
        seen_scopes.add(key)
        scopes.append({"scope_type": p["scope_type"], "scope_value": p["scope_value"]})

    session_id = sessions_service.create_session(conn, officer["id"])
    payload = {
        "sub": str(officer["id"]),
        "badge_number": officer["badge_number"],
        "name": officer["name"],
        "role": primary["role_name"] if primary else None,
        "scope_type": primary["scope_type"] if primary else None,
        "scope_value": primary["scope_value"] if primary else None,
        "scopes": scopes,
        "permissions": sorted(permission_set),
        "sid": session_id,
        "exp": datetime.now(timezone.utc) + TOKEN_LIFETIME,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def issue_pending_login_token(officer_id: int) -> str:
    """Handed back to the client from POST /auth/login when 2FA is required
    -- proves badge_number+password already passed, for the sole purpose of
    letting POST /auth/verify-login-otp trust the officer_id it's verifying
    a code against, without asking for the password a second time."""
    payload = {
        "purpose": PENDING_LOGIN_PURPOSE,
        "officer_id": officer_id,
        "exp": datetime.now(timezone.utc) + PENDING_LOGIN_TOKEN_LIFETIME,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_pending_login_token(token: str) -> int:
    """Returns the officer_id it was issued for. Raises jwt.InvalidTokenError
    (expired, tampered, or simply not one of these tokens at all -- e.g. a
    real session JWT passed here by mistake) -- callers let that propagate
    into a 401, same as every other invalid-token case in this codebase."""
    payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    if payload.get("purpose") != PENDING_LOGIN_PURPOSE:
        raise jwt.InvalidTokenError("Not a pending-login token")
    return int(payload["officer_id"])


def issue_pending_email_verification_token(officer_id: int, candidate_email: str) -> str:
    """Handed back to the client from PUT /auth/me/email (and POST
    /auth/register) when the submitted email still needs proving -- carries
    the candidate address itself, since nothing is written to officers.email
    until POST /auth/me/email/verify (or /auth/register/verify) succeeds."""
    payload = {
        "purpose": PENDING_EMAIL_VERIFICATION_PURPOSE,
        "officer_id": officer_id,
        "candidate_email": candidate_email,
        "exp": datetime.now(timezone.utc) + PENDING_EMAIL_VERIFICATION_TOKEN_LIFETIME,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_pending_email_verification_token(token: str) -> tuple[int, str]:
    """Returns (officer_id, candidate_email). Raises jwt.InvalidTokenError
    on anything wrong with the token -- same handling as
    decode_pending_login_token."""
    payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    if payload.get("purpose") != PENDING_EMAIL_VERIFICATION_PURPOSE:
        raise jwt.InvalidTokenError("Not a pending-email-verification token")
    return int(payload["officer_id"]), payload["candidate_email"]
