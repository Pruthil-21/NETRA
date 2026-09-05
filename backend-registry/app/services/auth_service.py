# backend-registry/app/services/auth_service.py
"""Password hashing and JWT issuance for real officer login (as opposed to
the hand-crafted test/demo JWTs used elsewhere in this codebase)."""
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from ..config import settings
from . import rbac_service

# Precomputed bcrypt hash of a fixed dummy value -- used when no officer
# matches the submitted badge number, so verify_password() still runs and
# the response time doesn't leak whether the badge number exists.
DUMMY_PASSWORD_HASH = bcrypt.hashpw(b"dummy-password-for-constant-time-login", bcrypt.gensalt()).decode("utf-8")

TOKEN_LIFETIME = timedelta(hours=12)


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


def get_officer_by_badge(conn, badge_number: str) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, badge_number, name, rank, password_hash, photo_url FROM officers WHERE badge_number = %s",
            (badge_number,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        cols = [c.name for c in cur.description]
        return dict(zip(cols, row))


def get_officer_by_id(conn, officer_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, badge_number, name, rank, password_hash, photo_url FROM officers WHERE id = %s",
            (officer_id,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        cols = [c.name for c in cur.description]
        return dict(zip(cols, row))


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


def set_photo_url(conn, officer_id: int, photo_url: str | None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE officers SET photo_url = %s WHERE id = %s",
            (photo_url, officer_id),
        )
        conn.commit()


def get_active_posting(conn, officer_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT p.id, p.role_id, p.scope_type, p.scope_value, r.name AS role_name
            FROM postings p
            JOIN roles r ON r.id = p.role_id
            WHERE p.officer_id = %s AND p.is_active
            """,
            (officer_id,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        cols = [c.name for c in cur.description]
        return dict(zip(cols, row))


def issue_token(conn, officer: dict, posting: dict) -> str:
    permissions = rbac_service.role_permissions(conn, posting["role_id"])
    payload = {
        "sub": str(officer["id"]),
        "badge_number": officer["badge_number"],
        "name": officer["name"],
        "role": posting["role_name"],
        "scope_type": posting["scope_type"],
        "scope_value": posting["scope_value"],
        "permissions": permissions,
        "exp": datetime.now(timezone.utc) + TOKEN_LIFETIME,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")
