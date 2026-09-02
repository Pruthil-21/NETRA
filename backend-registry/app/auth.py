"""JWT auth + role-based access control.

Duplicated (not shared) in backend-registry and backend-watchlist by design —
keeps each service independently owned with zero cross-folder edits.
"""
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
