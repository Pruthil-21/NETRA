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