"""JWT auth + role-based access control.

Duplicated (not shared) in backend-registry and backend-watchlist by design —
keeps each service independently owned with zero cross-folder edits.
"""
import jwt
from fastapi import Depends, Header, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import settings

security = HTTPBearer()


def get_current_user(creds: HTTPAuthorizationCredentials = Depends(security)):
    try:
        return jwt.decode(creds.credentials, settings.jwt_secret, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


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


def require_internal_key(x_internal_key: str = Header(...)):
    if x_internal_key != settings.internal_service_key:
        raise HTTPException(status_code=401, detail="Invalid internal service key")
    return True


# Mirrors backend-registry's scripts/seed_rbac.py PERMISSIONS table. This
# service has no roles/role_permissions tables of its own (that data is
# owned by backend-registry), so a real RBAC-issued token's own
# `permissions` claim is checked first -- it already reflects any per-role
# customization made via backend-registry's admin endpoints -- and this
# static table is only a fallback for a token that carries an empty/missing
# permissions claim (e.g. a hand-built token, since a real login-issued one
# always has this claim populated).
_ROLE_DEFAULT_PERMISSIONS = {
    "super_admin": {
        "view_live_feeds", "search_vehicles", "edit_watchlist", "manage_cameras",
        "view_analytics", "export_data", "manage_users_roles", "view_audit_logs",
        "acknowledge_alerts", "manage_roles",
    },
    "district_command": {
        "view_live_feeds", "search_vehicles", "edit_watchlist", "manage_cameras",
        "view_analytics", "export_data", "manage_users_roles", "acknowledge_alerts",
    },
    "station_officer": {"view_live_feeds", "search_vehicles", "edit_watchlist", "acknowledge_alerts"},
    "control_room_operator": {"view_live_feeds", "acknowledge_alerts"},
    "auditor": {"view_audit_logs"},
}


def has_permission(user: dict, permission: str) -> bool:
    """Usable inline when a permission check is conditional rather than a
    route-wide Depends (e.g. only required for one branch of an endpoint,
    not every request to it). A pre-RBAC hand-crafted token (role
    "officer"/"admin", no permissions claim -- what require_role("officer")
    already trusts everywhere else in this codebase) is treated as fully
    trusted here too."""
    if user.get("role") in ("officer", "admin") and "permissions" not in user:
        return True
    permissions = user.get("permissions") or []
    if permission in permissions:
        return True
    if not permissions:
        return permission in _ROLE_DEFAULT_PERMISSIONS.get(user.get("role"), set())
    return False