"""Manual registration approve/reject and officer lifecycle management --
the admin-side counterpart to routers/auth.py's self-service register/
verify flow. Approve/reject remain available as a fast-track/override an
admin can use before a registrant ever checks their email (see
routers/auth.py's register() docstring)."""
from fastapi import APIRouter, Depends, HTTPException

from ..auth import require_permission
from ..db import get_conn
from ..rbac_scope import guard_delegated_posting_assignment
from ..schemas import (
    OfficerOut,
    OfficerProfileOut,
    PasswordResetBody,
    RegistrationApprove,
    RegistrationReject,
    RegistrationRequestOut,
)
from ..services import (
    admin_service,
    audit_service,
    auth_service,
    notifications_service,
    password_policy_service,
    rbac_service,
    registration_service,
    sessions_service,
)

router = APIRouter(prefix="/admin", tags=["registration & officers"])


@router.get("/approvals", response_model=list[RegistrationRequestOut])
def list_approvals(status: str | None = None, user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        return registration_service.list_requests(conn, status)


@router.post("/approvals/{request_id}/approve", response_model=RegistrationRequestOut)
def approve_registration(
    request_id: int, body: RegistrationApprove, user=Depends(require_permission("manage_users_roles"))
):
    """Approve = assign an initial posting (role + scope) in the same
    action (spec Section 3.2) -- this is really just admin_service.add_posting
    plus flipping the officer's status to 'active' and the request's own
    status to 'approved', all in one call."""
    with get_conn() as conn:
        request = registration_service.get_request(conn, request_id)
        if request is None or request["status"] != "pending":
            raise HTTPException(status_code=404, detail="Registration request not found or already reviewed")
        role = rbac_service.get_role_by_name(conn, body.role_name)
        if role is None:
            raise HTTPException(status_code=404, detail=f"Unknown role '{body.role_name}'")
        if not role["is_active"]:
            raise HTTPException(status_code=400, detail=f"Role '{body.role_name}' is deactivated and cannot be newly assigned")

        guard_delegated_posting_assignment(conn, user, role, body.scope_type, body.scope_value)

        admin_service.add_posting(
            conn, request["officer_id"], role["id"], body.scope_type, body.scope_value,
            assigned_by=user.get("badge_number", user.get("sub", "")),
        )
        admin_service.set_officer_status(conn, request["officer_id"], "active")
        updated = registration_service.mark_approved(conn, request_id, user.get("badge_number", user.get("sub")))
        audit_service.log(
            conn, user.get("badge_number", user.get("sub")), "approve_registration", "officer", request["officer_id"]
        )
        notifications_service.notify(
            conn, request["officer_id"], "registration_approved",
            f"Your registration was approved as '{role['name']}'.",
        )
        return updated


@router.post("/approvals/{request_id}/reject", response_model=RegistrationRequestOut)
def reject_registration(
    request_id: int, body: RegistrationReject, user=Depends(require_permission("manage_users_roles"))
):
    """Reject: records a reason, and the account is deactivated outright
    (spec Section 3.2 leaves this admin's choice between "stays access-
    less" and "gets deactivated" -- deactivated is the deterministic,
    unambiguous default; a Super Admin can always reactivate + approve
    properly later if it was a mistake)."""
    with get_conn() as conn:
        request = registration_service.get_request(conn, request_id)
        if request is None or request["status"] != "pending":
            raise HTTPException(status_code=404, detail="Registration request not found or already reviewed")
        admin_service.set_officer_status(conn, request["officer_id"], "deactivated")
        updated = registration_service.mark_rejected(conn, request_id, user.get("badge_number", user.get("sub")), body.reason)
        audit_service.log(
            conn, user.get("badge_number", user.get("sub")), "reject_registration", "officer", request["officer_id"],
            reason_code=body.reason,
        )
        notifications_service.notify(
            conn, request["officer_id"], "registration_rejected",
            f"Your registration was rejected.{f' Reason: {body.reason}' if body.reason else ''}",
        )
        return updated


@router.get("/officers/{officer_id}", response_model=OfficerProfileOut)
def get_officer_profile(officer_id: int, user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        profile = admin_service.get_officer_profile(conn, officer_id)
        if profile is None:
            raise HTTPException(status_code=404, detail="Officer not found")
        return profile


@router.post("/officers/{officer_id}/suspend", status_code=204)
def suspend_officer(officer_id: int, user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        if not admin_service.set_officer_status(conn, officer_id, "suspended"):
            raise HTTPException(status_code=404, detail="Officer not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "suspend_officer", "officer", officer_id)


@router.post("/officers/{officer_id}/reactivate", status_code=204)
def reactivate_officer(officer_id: int, user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        if not admin_service.set_officer_status(conn, officer_id, "active"):
            raise HTTPException(status_code=404, detail="Officer not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "reactivate_officer", "officer", officer_id)


@router.post("/officers/{officer_id}/force-logout", status_code=204)
def force_logout(officer_id: int, user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        if auth_service.get_officer_by_id(conn, officer_id) is None:
            raise HTTPException(status_code=404, detail="Officer not found")
        sessions_service.revoke_all_sessions(conn, officer_id)
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "force_logout", "officer", officer_id)


@router.post("/officers/{officer_id}/unlock", status_code=204)
def unlock_officer(officer_id: int, user=Depends(require_permission("manage_users_roles"))):
    """Admin override to clear an account lockout before its cooldown
    naturally expires (spec Section 3.6)."""
    with get_conn() as conn:
        if auth_service.get_officer_by_id(conn, officer_id) is None:
            raise HTTPException(status_code=404, detail="Officer not found")
        auth_service.unlock_officer(conn, officer_id)
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "unlock_officer", "officer", officer_id)


@router.get("/officers", response_model=list[OfficerOut])
def list_officers(user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        return admin_service.list_officers(conn)


# Deliberately gated on its own permission (reset_officer_passwords), not
# manage_users_roles -- district_command holds manage_users_roles for
# reassigning postings within its own district, but resetting an officer's
# password bypasses their current credential entirely (no current_password
# check, unlike the self-service OTP-based reset in routers/auth.py) and
# must stay platform-wide-admin-only by default, the same way manage_roles
# was split out from manage_users_roles for role-definition edits.
@router.post("/officers/{officer_id}/reset-password", status_code=204)
def reset_officer_password(
    officer_id: int, body: PasswordResetBody, user=Depends(require_permission("reset_officer_passwords"))
):
    with get_conn() as conn:
        officer = auth_service.get_officer_by_id(conn, officer_id)
        if officer is None:
            raise HTTPException(status_code=404, detail="Officer not found")
        try:
            password_policy_service.validate_password_or_raise(
                body.new_password, user_inputs=[officer["badge_number"], officer["name"]]
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        auth_service.set_password(conn, officer["id"], auth_service.hash_password(body.new_password))
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "reset_password", "officer", officer["id"])
