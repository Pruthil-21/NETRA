"""Direct posting assignment/revocation -- an officer can hold several
simultaneously-active postings (spec Section 3.3); this only ever adds or
ends one specific posting, never edits permissions in place."""
from fastapi import APIRouter, Depends, HTTPException

from ..auth import require_permission
from ..db import get_conn
from ..rbac_scope import guard_delegated_posting_assignment
from ..schemas import PostingCreate, PostingOut
from ..services import admin_service, audit_service, notifications_service, rbac_service

router = APIRouter(prefix="/admin/postings", tags=["postings"])


@router.get("", response_model=list[PostingOut])
def list_postings(user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        return admin_service.list_postings(conn)


@router.post("", response_model=PostingOut, status_code=201)
def create_posting(body: PostingCreate, user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        role = rbac_service.get_role_by_name(conn, body.role_name)
        if role is None:
            raise HTTPException(status_code=404, detail=f"Unknown role '{body.role_name}'")
        if not role["is_active"]:
            raise HTTPException(status_code=400, detail=f"Role '{body.role_name}' is deactivated and cannot be newly assigned")

        guard_delegated_posting_assignment(conn, user, role, body.scope_type, body.scope_value)

        # SoD (separation-of-duty) enforcement is disabled for now -- see
        # the matching note in routers/registration_admin.py's
        # approve_registration.
        posting = admin_service.add_posting(
            conn, body.officer_id, role["id"], body.scope_type, body.scope_value,
            assigned_by=user.get("badge_number", user.get("sub", "")), expires_at=body.expires_at,
        )
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "add_posting", "posting", posting["id"])
        notifications_service.notify(
            conn, body.officer_id, "role_granted", f"You were granted the '{role['name']}' role."
        )
        return posting


@router.delete("/{posting_id}", status_code=204)
def delete_posting(posting_id: int, user=Depends(require_permission("manage_users_roles"))):
    """Revokes exactly this one posting -- an officer's other active
    postings are untouched (spec Section 3.3)."""
    with get_conn() as conn:
        revoked = admin_service.revoke_posting(conn, posting_id)
        if revoked is None:
            raise HTTPException(status_code=404, detail="Posting not found or already inactive")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "revoke_posting", "posting", posting_id)
        notifications_service.notify(
            conn, revoked["officer_id"], "role_revoked", f"Your '{revoked['role']}' posting was revoked."
        )
