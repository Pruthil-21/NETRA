"""JWT auth + role-based access control.

Duplicated (not shared) in backend-registry and backend-watchlist by design —
keeps each service independently owned with zero cross-folder edits.
"""
import os

import jwt
from fastapi import Depends, Header, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import settings

security = HTTPBearer()


def get_current_user(creds: HTTPAuthorizationCredentials = Depends(security)):
    try:
        payload = jwt.decode(creds.credentials, settings.jwt_secret, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    # Force-logout (spec Section 3.6): a real RBAC-issued token carries a
    # `sid` claim tying it to one sessions row. No claim at all (every
    # hand-crafted test/demo token, and any token issued before this
    # feature existed) means "not session-tracked" -- always valid, same as
    # today. Local import: avoids a module-load-time circular import
    # between auth.py and db.py/main.py.
    sid = payload.get("sid")
    if sid:
        from .db import get_conn
        from .services import sessions_service

        with get_conn() as conn:
            if sessions_service.is_session_revoked(conn, sid):
                raise HTTPException(status_code=401, detail="Session has been revoked")
    return payload


_RBAC_ROLES = ("super_admin", "district_command", "station_officer", "control_room_operator", "auditor")


def require_role(role: str):
    """`role` is the legacy pre-RBAC role name this checker was written for
    (e.g. "officer"). Any of the 5 real RBAC role names also passes -- RBAC
    permissions (require_permission/has_permission) are the finer-grained
    gate; require_role is just "is this an authenticated staff member,"
    which every RBAC role satisfies."""
    def checker(user=Depends(get_current_user)):
        if user["role"] not in (role, "admin") and user["role"] not in _RBAC_ROLES:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return user
    return checker


def require_permission(permission: str):
    """Additive alongside require_role, not a replacement for it. A
    pre-RBAC hand-crafted token (role: "officer"/"admin", no permissions
    claim -- what every existing test fixture and the demo JWT use) is
    treated as fully trusted here, exactly matching what require_role("officer")
    already does for it everywhere else in this codebase. A real RBAC-issued
    token (see auth_service.issue_token) always carries an explicit
    permissions list and is checked against it."""
    def checker(user=Depends(get_current_user)):
        if user.get("role") in ("officer", "admin") and "permissions" not in user:
            return user
        if permission not in user.get("permissions", []):
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return user
    return checker


def has_permission(user: dict, permission: str) -> bool:
    """Same logic as require_permission's checker, usable inline when the
    check is conditional rather than the route's own Depends (e.g. only
    required for one branch of an endpoint, not every request to it)."""
    if user.get("role") in ("officer", "admin") and "permissions" not in user:
        return True
    return permission in user.get("permissions", [])


def require_internal_key(x_internal_key: str = Header(...)):
    """Same shared-secret gate backend-watchlist's POST /detections already
    uses for ml-anpr -- service-to-service traffic, never a user JWT."""
    if x_internal_key != settings.internal_service_key:
        raise HTTPException(status_code=401, detail="Invalid internal service key")
    return True


def require_scale_demo_enabled():
    """Hard kill-switch for every synthetic/scale-demo endpoint. 404, not 403
    -- when disabled, these routes should look like they don't exist, not
    like a permission was denied (no reason to reveal the feature exists at
    all in an environment where it's off)."""
    if os.environ.get("SCALE_DEMO_ENABLED", "false").lower() != "true":
        raise HTTPException(status_code=404, detail="Not found")
