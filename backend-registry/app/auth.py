"""JWT auth + role-based access control.

Duplicated (not shared) in backend-registry and backend-watchlist by design —
keeps each service independently owned with zero cross-folder edits.
"""
import os

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import settings

security = HTTPBearer()


def get_current_user(creds: HTTPAuthorizationCredentials = Depends(security)):
    try:
        return jwt.decode(creds.credentials, settings.jwt_secret, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


def require_role(role: str):
    def checker(user=Depends(get_current_user)):
        if user["role"] not in (role, "admin"):
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


def require_scale_demo_enabled():
    """Hard kill-switch for every synthetic/scale-demo endpoint. 404, not 403
    -- when disabled, these routes should look like they don't exist, not
    like a permission was denied (no reason to reveal the feature exists at
    all in an environment where it's off)."""
    if os.environ.get("SCALE_DEMO_ENABLED", "false").lower() != "true":
        raise HTTPException(status_code=404, detail="Not found")
