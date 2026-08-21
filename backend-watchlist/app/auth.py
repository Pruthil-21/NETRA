"""JWT auth + role-based access control.

Duplicated (not shared) in backend-registry and backend-watchlist by design —
keeps each service independently owned with zero cross-folder edits.
See CLAUDE.md, "SECURITY/PRODUCTION DECISIONS".
"""
from fastapi import Depends, Header, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import jwt

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
from fastapi import Header


def require_internal_key(x_internal_key: str = Header(...)):
    if x_internal_key != settings.internal_service_key:
        raise HTTPException(status_code=401, detail="Invalid internal service key")
    return True