from datetime import datetime

import psycopg
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from .auth import (
    get_current_user,
    has_permission,
    require_permission,
    require_scale_demo_enabled,
)
from .db import get_conn
from .logging_config import configure_logging, logger
from .schemas import (
    AuditLogsPage,
    CameraBulkResult,
    CameraCreate,
    CameraOut,
    CameraUpdate,
    CameraUptimeReport,
    ChangePasswordRequest,
    CircleCreate,
    CircleOut,
    CircleUpdate,
    CoverageTargetCreate,
    CoverageTargetOut,
    CoverageTargetUpdate,
    DataJobCreate,
    DataJobOut,
    DiagnosticsOut,
    DutyCreate,
    DutyOut,
    DutyUpdate,
    EffectivePermissionsOut,
    GapAnalysisReport,
    LoginRequest,
    LoginResponse,
    MeResponse,
    NotificationOut,
    OfficerOut,
    OfficerProfileOut,
    PasswordResetBody,
    PasswordResetRequestCreate,
    PasswordResetRequestOut,
    PasswordResetRequestReject,
    PoliceStationCreate,
    PoliceStationOut,
    PoliceStationUpdate,
    PostingCreate,
    PostingOut,
    ProfilePhotoUpdate,
    RegisterRequest,
    RegistrationApprove,
    RegistrationReject,
    RegistrationRequestOut,
    ReportSummary,
    RoleCloneRequest,
    RoleCreate,
    RoleDiffOut,
    RoleDraftOut,
    RoleDraftUpdate,
    RoleDutiesUpdate,
    RoleOut,
    RolePermissionsOut,
    RolePermissionsUpdate,
    SodRuleCreate,
    SodRuleOut,
    SyntheticDetectionEventAccepted,
    SyntheticDetectionEventIn,
)
from .services import (
    admin_service,
    audit_logs_service,
    audit_service,
    auth_service,
    cameras_service,
    circles_service,
    coverage_targets_service,
    gap_analysis_service,
    import_export_service,
    notifications_service,
    password_reset_requests_service,
    police_stations_service,
    rbac_service,
    recordings_service,
    registration_service,
    reports_service,
    sessions_service,
    snmp_service,
    synthetic_events_service,
)

configure_logging()

app = FastAPI()

# Browser clients (frontend-dashboard, frontend-map) send an Authorization
# header cross-origin, which forces a CORS preflight (OPTIONS) -- without this,
# FastAPI has no route for OPTIONS and rejects it with 405 before the real
# request is ever sent.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


def _effective_district_scopes(user: dict) -> list[str] | None:
    """Multi-role jurisdiction (spec Section 3.3): "effective jurisdiction is
    the union of every active posting's scope." Returns None for
    platform-wide (no filter -- sees/manages everything), an empty list for
    "holds no district jurisdiction at all" (a pending officer with zero
    postings, or a legacy token that somehow carries neither), or the
    deduplicated list of every district this officer is actively posted to.

    Falls back to the token's single legacy scope_type/scope_value pair
    when no `scopes` claim is present at all -- every hand-crafted test/demo
    token, and any token issued before multi-posting existed."""
    scopes = user.get("scopes")
    if scopes is None:
        if user.get("scope_type") == "district":
            return [user.get("scope_value")]
        # Platform, or a legacy hand-crafted token with no scope_type claim
        # at all -- both are unrestricted, matching this codebase's original
        # single-scope behavior before multi-posting existed. Only a real
        # RBAC-issued token's *explicit*, empty `scopes` list (an officer
        # who genuinely holds zero active postings) means "no jurisdiction".
        return None
    if not scopes:
        return []
    if any(s.get("scope_type") == "platform" for s in scopes):
        return None
    return sorted({s["scope_value"] for s in scopes if s.get("scope_type") == "district" and s.get("scope_value")})


def _resolve_district_scoped(dept_scopes: list[str] | None, fetch_all, fetch_by_district):
    """Applies _effective_district_scopes' result to a single-district-filter
    fetch function: None -> no filter (fetch_all), [] -> no jurisdiction at
    all (empty, never fetch_all), one district -> the existing single-value
    path unchanged, several -> merge each district's rows, deduped by id."""
    if dept_scopes is None:
        return fetch_all()
    if not dept_scopes:
        return []
    if len(dept_scopes) == 1:
        return fetch_by_district(dept_scopes[0])
    merged: dict[int, dict] = {}
    for district in dept_scopes:
        for row in fetch_by_district(district):
            merged[row["id"]] = row
    return list(merged.values())


@app.post("/auth/login", response_model=LoginResponse)
def login(body: LoginRequest):
    with get_conn() as conn:
        officer = auth_service.get_officer_by_badge(conn, body.badge_number)
        password_hash = officer["password_hash"] if officer else auth_service.DUMMY_PASSWORD_HASH
        password_ok = auth_service.verify_password(body.password, password_hash)

        # Locked-out is checked before the password itself: a locked account
        # rejects every attempt (right password included) until the cooldown
        # passes or an admin unlocks it early -- otherwise lockout would be
        # trivially bypassable by anyone who already knows the real password.
        if officer is not None and auth_service.is_locked(officer):
            raise HTTPException(status_code=423, detail="Account is locked due to too many failed login attempts")

        if officer is None or not password_ok:
            if officer is not None:
                auth_service.record_failed_login(conn, officer["id"])
            raise HTTPException(status_code=401, detail="Invalid badge number or password")

        if officer["status"] in ("suspended", "deactivated"):
            raise HTTPException(status_code=403, detail=f"Account is {officer['status']}")

        # 'pending' (a freshly self-registered officer, spec Section 3.2) and
        # 'active' both reach here -- a pending officer still gets a token,
        # just one carrying zero postings/permissions, so the frontend can
        # show the "awaiting approval" empty shell instead of a login error.
        postings = auth_service.get_active_postings(conn, officer["id"])
        token = auth_service.issue_token(conn, officer, postings)
        auth_service.record_successful_login(conn, officer["id"])
        audit_service.log(conn, officer["badge_number"], "login", "officer", officer["id"], badge_number=officer["badge_number"])
        return {"token": token}


@app.get("/auth/me", response_model=MeResponse)
def me(user=Depends(get_current_user)):
    response = {
        "badge_number": user.get("badge_number", user.get("sub", "")),
        "name": user.get("name", ""),
        "role": user.get("role", ""),
        "rank": None,
        "photo_url": None,
        "last_login": None,
        "status": "active",
        "scope_type": user.get("scope_type", "platform"),
        "scope_value": user.get("scope_value"),
        "permissions": user.get("permissions", []),
    }
    # A real RBAC-issued token's `sub` is the officer's numeric id (see
    # auth_service.issue_token) -- a legacy hand-crafted token (role:
    # "officer"/"admin", every existing test fixture and the demo JWT) has no
    # matching officers row, so profile fields beyond the JWT's own claims
    # just stay at their defaults above rather than erroring.
    officer_id = user.get("sub")
    if officer_id and str(officer_id).isdigit():
        with get_conn() as conn:
            officer = auth_service.get_officer_by_id(conn, int(officer_id))
            if officer is not None:
                response["rank"] = officer["rank"]
                response["photo_url"] = officer["photo_url"]
                response["last_login"] = auth_service.get_last_login(conn, officer["id"])
                # 'pending' is the only status that ever reaches here with a
                # valid token (suspended/deactivated are rejected at login) --
                # this is the frontend's signal to show the "awaiting
                # approval" empty shell instead of the normal dashboard.
                response["status"] = officer["status"]
    return response


@app.post("/auth/register", response_model=RegistrationRequestOut, status_code=201)
def register(body: RegisterRequest):
    """Public self-registration (spec Section 3.2). Creates the officer row
    immediately, status='pending', with zero postings -- matches D365's "no
    role, no privileges" rule: the account exists and can log in, it just
    sees an empty shell until a Super Admin/District Command approves it
    with an initial posting. No permission gate -- this is the one endpoint
    meant for someone who isn't an officer yet."""
    with get_conn() as conn:
        if auth_service.get_officer_by_badge(conn, body.badge_number) is not None:
            raise HTTPException(status_code=409, detail="Badge number already registered")
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO officers (badge_number, name, rank, password_hash, status) "
                "VALUES (%s, %s, %s, %s, 'pending') RETURNING id",
                (body.badge_number, body.name, body.rank, auth_service.hash_password(body.password)),
            )
            officer_id = cur.fetchone()[0]
        conn.commit()
        created = registration_service.create_request(conn, officer_id, body.department, body.contact_info)
        audit_service.log(conn, body.badge_number, "self_register", "officer", officer_id, badge_number=body.badge_number)
        return created


@app.get("/admin/approvals", response_model=list[RegistrationRequestOut])
def list_approvals(status: str | None = None, user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        return registration_service.list_requests(conn, status)


@app.post("/admin/approvals/{request_id}/approve", response_model=RegistrationRequestOut)
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

        _guard_delegated_posting_assignment(conn, user, role, body.scope_type, body.scope_value)

        conflict = rbac_service.find_sod_conflict(conn, request["officer_id"], role["id"])
        if conflict is not None:
            raise HTTPException(
                status_code=409,
                detail=f"Separation of duty: cannot hold both '{conflict['role_a_name']}' and '{conflict['role_b_name']}' at once",
            )

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


@app.post("/admin/approvals/{request_id}/reject", response_model=RegistrationRequestOut)
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


@app.get("/admin/officers/{officer_id}", response_model=OfficerProfileOut)
def get_officer_profile(officer_id: int, user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        profile = admin_service.get_officer_profile(conn, officer_id)
        if profile is None:
            raise HTTPException(status_code=404, detail="Officer not found")
        return profile


@app.post("/admin/officers/{officer_id}/suspend", status_code=204)
def suspend_officer(officer_id: int, user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        if not admin_service.set_officer_status(conn, officer_id, "suspended"):
            raise HTTPException(status_code=404, detail="Officer not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "suspend_officer", "officer", officer_id)


@app.post("/admin/officers/{officer_id}/reactivate", status_code=204)
def reactivate_officer(officer_id: int, user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        if not admin_service.set_officer_status(conn, officer_id, "active"):
            raise HTTPException(status_code=404, detail="Officer not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "reactivate_officer", "officer", officer_id)


@app.post("/admin/officers/{officer_id}/force-logout", status_code=204)
def force_logout(officer_id: int, user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        if auth_service.get_officer_by_id(conn, officer_id) is None:
            raise HTTPException(status_code=404, detail="Officer not found")
        sessions_service.revoke_all_sessions(conn, officer_id)
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "force_logout", "officer", officer_id)


@app.post("/admin/officers/{officer_id}/unlock", status_code=204)
def unlock_officer(officer_id: int, user=Depends(require_permission("manage_users_roles"))):
    """Admin override to clear an account lockout before its cooldown
    naturally expires (spec Section 3.6)."""
    with get_conn() as conn:
        if auth_service.get_officer_by_id(conn, officer_id) is None:
            raise HTTPException(status_code=404, detail="Officer not found")
        auth_service.unlock_officer(conn, officer_id)
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "unlock_officer", "officer", officer_id)


@app.post("/auth/change-password", status_code=204)
def change_password(body: ChangePasswordRequest, user=Depends(get_current_user)):
    officer_id = user.get("sub")
    if not officer_id or not str(officer_id).isdigit():
        raise HTTPException(status_code=400, detail="This session has no officer account to update")
    with get_conn() as conn:
        officer = auth_service.get_officer_by_id(conn, int(officer_id))
        if officer is None or not auth_service.verify_password(body.current_password, officer["password_hash"]):
            raise HTTPException(status_code=401, detail="Current password is incorrect")
        auth_service.set_password(conn, officer["id"], auth_service.hash_password(body.new_password))
        audit_service.log(conn, officer["badge_number"], "change_password", "officer", officer["id"], badge_number=officer["badge_number"])


@app.put("/auth/me/photo", response_model=MeResponse)
def update_my_photo(body: ProfilePhotoUpdate, user=Depends(get_current_user)):
    officer_id = user.get("sub")
    if not officer_id or not str(officer_id).isdigit():
        raise HTTPException(status_code=400, detail="This session has no officer account to update")
    with get_conn() as conn:
        officer = auth_service.get_officer_by_id(conn, int(officer_id))
        if officer is None:
            raise HTTPException(status_code=404, detail="Officer not found")
        auth_service.set_photo_url(conn, officer["id"], body.photo_url)
        return me(user)


@app.get("/admin/officers", response_model=list[OfficerOut])
def list_officers(user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        return admin_service.list_officers(conn)


# Deliberately gated on its own permission (reset_officer_passwords), not
# manage_users_roles -- district_command holds manage_users_roles for
# reassigning postings within its own district, but resetting an officer's
# password bypasses their current credential entirely (no current_password
# check, unlike self-service POST /auth/change-password) and must stay
# platform-wide-admin-only by default, the same way manage_roles was split
# out from manage_users_roles for role-definition edits.
@app.post("/admin/officers/{officer_id}/reset-password", status_code=204)
def reset_officer_password(
    officer_id: int, body: PasswordResetBody, user=Depends(require_permission("reset_officer_passwords"))
):
    with get_conn() as conn:
        officer = auth_service.get_officer_by_id(conn, officer_id)
        if officer is None:
            raise HTTPException(status_code=404, detail="Officer not found")
        auth_service.set_password(conn, officer["id"], auth_service.hash_password(body.new_password))
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "reset_password", "officer", officer["id"])
        if body.request_id is not None:
            password_reset_requests_service.mark_reviewed(
                conn, body.request_id, "approved", user.get("badge_number", user.get("sub"))
            )


@app.post("/auth/password-reset-requests", response_model=PasswordResetRequestOut, status_code=201)
def request_password_reset(body: PasswordResetRequestCreate, user=Depends(get_current_user)):
    officer_id = user.get("sub")
    if not officer_id or not str(officer_id).isdigit():
        raise HTTPException(status_code=400, detail="This session has no officer account to request a reset for")
    with get_conn() as conn:
        created = password_reset_requests_service.create_request(conn, int(officer_id), body.reason)
        audit_service.log(
            conn, user.get("badge_number", user.get("sub")), "request_password_reset", "officer", int(officer_id)
        )
        requests = password_reset_requests_service.list_requests(conn)
        return next(r for r in requests if r["id"] == created["id"])


@app.get("/admin/password-reset-requests", response_model=list[PasswordResetRequestOut])
def list_password_reset_requests(
    status: str | None = None, user=Depends(require_permission("reset_officer_passwords"))
):
    with get_conn() as conn:
        return password_reset_requests_service.list_requests(conn, status)


@app.post("/admin/password-reset-requests/{request_id}/reject", response_model=PasswordResetRequestOut)
def reject_password_reset_request(
    request_id: int, body: PasswordResetRequestReject, user=Depends(require_permission("reset_officer_passwords"))
):
    with get_conn() as conn:
        updated = password_reset_requests_service.mark_reviewed(
            conn, request_id, "rejected", user.get("badge_number", user.get("sub"))
        )
        if updated is None:
            raise HTTPException(status_code=404, detail="Request not found or already reviewed")
        audit_service.log(
            conn, user.get("badge_number", user.get("sub")), "reject_password_reset", "officer", updated["officer_id"],
            reason_code=body.reason,
        )
        requests = password_reset_requests_service.list_requests(conn)
        return next(r for r in requests if r["id"] == request_id)


@app.get("/admin/postings", response_model=list[PostingOut])
def list_postings(user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        return admin_service.list_postings(conn)


def _guard_delegated_posting_assignment(conn, user: dict, role: dict, scope_type: str, scope_value: str | None) -> None:
    """Delegated admin (spec Section 6/3.8): a platform-wide actor (Super
    Admin) can assign anything. A district-scoped actor with
    can_delegate_admin (District Command) can only assign within one of
    their own effective jurisdictions -- the union of every active
    posting's district scope (spec Section 3.3), never a district outside
    all of them -- and, now that roles are dynamic (data, not a fixed
    5-name list), only roles whose hierarchy_level is strictly junior to
    their own: a role's numeric level increases the more junior it is
    (super_admin=1 is senior-most), and NULL means "outside the
    operational hierarchy" (e.g. auditor), always assignable by a delegate.
    An actor whose own role can't be resolved, or carries no
    hierarchy_level itself, can't safely compare levels at all and is
    denied by default. Shared by both direct posting assignment
    (create_posting) and approving a registration (which is really just
    "assign this person's first posting")."""
    actor_district_scopes = _effective_district_scopes(user)
    if actor_district_scopes is None:
        return
    if scope_type != "district" or scope_value not in actor_district_scopes:
        raise HTTPException(status_code=403, detail="Cannot assign outside your own jurisdiction")
    actor_role = rbac_service.get_role_by_name(conn, user.get("role", ""))
    actor_level = actor_role["hierarchy_level"] if actor_role else None
    target_level = role["hierarchy_level"]
    if actor_level is None or (target_level is not None and target_level <= actor_level):
        raise HTTPException(status_code=403, detail="Cannot assign a role at or above your own")


@app.post("/admin/postings", response_model=PostingOut, status_code=201)
def create_posting(body: PostingCreate, user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        role = rbac_service.get_role_by_name(conn, body.role_name)
        if role is None:
            raise HTTPException(status_code=404, detail=f"Unknown role '{body.role_name}'")
        if not role["is_active"]:
            raise HTTPException(status_code=400, detail=f"Role '{body.role_name}' is deactivated and cannot be newly assigned")

        _guard_delegated_posting_assignment(conn, user, role, body.scope_type, body.scope_value)

        conflict = rbac_service.find_sod_conflict(conn, body.officer_id, role["id"])
        if conflict is not None:
            audit_service.log(
                conn, user.get("badge_number", user.get("sub")), "sod_conflict_blocked", "officer", body.officer_id,
                reason_code=f"{conflict['role_a_name']}+{conflict['role_b_name']}",
            )
            raise HTTPException(
                status_code=409,
                detail=f"Separation of duty: cannot hold both '{conflict['role_a_name']}' and '{conflict['role_b_name']}' at once",
            )

        posting = admin_service.add_posting(
            conn, body.officer_id, role["id"], body.scope_type, body.scope_value,
            assigned_by=user.get("badge_number", user.get("sub", "")), expires_at=body.expires_at,
        )
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "add_posting", "posting", posting["id"])
        notifications_service.notify(
            conn, body.officer_id, "role_granted", f"You were granted the '{role['name']}' role."
        )
        return posting


@app.delete("/admin/postings/{posting_id}", status_code=204)
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


@app.get("/notifications", response_model=list[NotificationOut])
def list_my_notifications(unread_only: bool = False, user=Depends(get_current_user)):
    officer_id = user.get("sub")
    if not officer_id or not str(officer_id).isdigit():
        return []
    with get_conn() as conn:
        return notifications_service.list_for_officer(conn, int(officer_id), unread_only)


@app.post("/notifications/{notification_id}/read", status_code=204)
def mark_notification_read(notification_id: int, user=Depends(get_current_user)):
    officer_id = user.get("sub")
    if not officer_id or not str(officer_id).isdigit():
        raise HTTPException(status_code=400, detail="This session has no officer account")
    with get_conn() as conn:
        if not notifications_service.mark_read(conn, int(officer_id), notification_id):
            raise HTTPException(status_code=404, detail="Notification not found")


@app.get("/admin/sod-rules", response_model=list[SodRuleOut])
def list_sod_rules(user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        return rbac_service.list_sod_rules(conn)


@app.post("/admin/sod-rules", response_model=SodRuleOut, status_code=201)
def create_sod_rule(body: SodRuleCreate, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_role(conn, body.role_a_id) is None or rbac_service.get_role(conn, body.role_b_id) is None:
            raise HTTPException(status_code=404, detail="Role not found")
        try:
            rule = rbac_service.create_sod_rule(conn, body.role_a_id, body.role_b_id, body.description)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create_sod_rule", "sod_rule", rule["id"])
        return rule


@app.delete("/admin/sod-rules/{rule_id}", status_code=204)
def delete_sod_rule(rule_id: int, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if not rbac_service.delete_sod_rule(conn, rule_id):
            raise HTTPException(status_code=404, detail="Rule not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete_sod_rule", "sod_rule", rule_id)


@app.get("/admin/roles", response_model=list[RolePermissionsOut])
def list_roles(user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        return rbac_service.list_roles_with_permissions(conn)


@app.put("/admin/roles/{role_name}/permissions", response_model=RolePermissionsOut)
def update_role_permissions(
    role_name: str, body: RolePermissionsUpdate, user=Depends(require_permission("manage_roles"))
):
    with get_conn() as conn:
        role = rbac_service.get_role_by_name(conn, role_name)
        if role is None:
            raise HTTPException(status_code=404, detail=f"Unknown role '{role_name}'")

        unknown = set(body.permissions) - rbac_service.VALID_PERMISSIONS
        if unknown:
            raise HTTPException(status_code=400, detail=f"Unknown permission(s): {', '.join(sorted(unknown))}")

        if role["name"] == "super_admin" and "manage_roles" not in body.permissions:
            raise HTTPException(status_code=400, detail="Cannot remove manage_roles from super_admin")

        permissions = rbac_service.set_role_permissions(conn, role["id"], body.permissions)
        audit_service.log(
            conn, user.get("badge_number", user.get("sub")), "edit_role_permissions",
            "role", role["id"], reason_code=body.reason_code,
        )
        return {**role, "permissions": permissions}


# --- Dynamic role/duty management (v2 spec, Phase A) -------------------
# Distinct from the name-keyed pair above (list_roles/update_role_permissions),
# which stays for the existing "edit an existing role's permission list" UI.
# These operate by numeric id and cover the newer capability: creating a
# brand-new role, composing it from duties, cloning, and deactivate-vs-delete.


def _role_to_out(conn, role: dict) -> dict:
    return {
        **role,
        "duty_ids": rbac_service.get_role_duty_ids(conn, role["id"]),
        "permissions": rbac_service.role_permissions(conn, role["id"]),
    }


@app.get("/admin/roles/{role_id}/effective-permissions", response_model=EffectivePermissionsOut)
def get_effective_role_permissions(role_id: int, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        role = rbac_service.get_role(conn, role_id)
        if role is None:
            raise HTTPException(status_code=404, detail="Role not found")
        return {"role_id": role_id, "permissions": rbac_service.effective_role_permissions(conn, role_id)}


@app.post("/admin/roles", response_model=RoleOut, status_code=201)
def create_role_v2(body: RoleCreate, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_role_by_name(conn, body.name) is not None:
            raise HTTPException(status_code=409, detail=f"Role '{body.name}' already exists")
        unknown = set(body.permissions) - rbac_service.VALID_PERMISSIONS
        if unknown:
            raise HTTPException(status_code=400, detail=f"Unknown permission(s): {', '.join(sorted(unknown))}")
        if body.parent_role_id is not None and rbac_service.get_role(conn, body.parent_role_id) is None:
            raise HTTPException(status_code=404, detail="Parent role not found")
        for duty_id in body.duty_ids:
            if rbac_service.get_duty(conn, duty_id) is None:
                raise HTTPException(status_code=404, detail=f"Duty {duty_id} not found")

        role = rbac_service.create_role(
            conn, body.name, body.display_name, body.hierarchy_level, body.can_delegate_admin,
            parent_role_id=body.parent_role_id, duty_ids=body.duty_ids, permissions=body.permissions,
        )
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create_role", "role", role["id"])
        return _role_to_out(conn, role)


@app.post("/admin/roles/{role_id}/clone", response_model=RoleOut, status_code=201)
def clone_role(role_id: int, body: RoleCloneRequest, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_role(conn, role_id) is None:
            raise HTTPException(status_code=404, detail="Role not found")
        if rbac_service.get_role_by_name(conn, body.name) is not None:
            raise HTTPException(status_code=409, detail=f"Role '{body.name}' already exists")
        clone = rbac_service.clone_role(conn, role_id, body.name, body.display_name)
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "clone_role", "role", clone["id"])
        return _role_to_out(conn, clone)


@app.put("/admin/roles/{role_id}/duties", response_model=RoleOut)
def update_role_duties(role_id: int, body: RoleDutiesUpdate, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        role = rbac_service.get_role(conn, role_id)
        if role is None:
            raise HTTPException(status_code=404, detail="Role not found")
        for duty_id in body.duty_ids:
            if rbac_service.get_duty(conn, duty_id) is None:
                raise HTTPException(status_code=404, detail=f"Duty {duty_id} not found")
        rbac_service.set_role_duties(conn, role_id, body.duty_ids)
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "edit_role_duties", "role", role_id)
        return _role_to_out(conn, rbac_service.get_role(conn, role_id))


@app.put("/admin/roles/{role_id}/draft", response_model=RoleDraftOut)
def save_role_draft(role_id: int, body: RoleDraftUpdate, user=Depends(require_permission("manage_roles"))):
    """Draft/Publish (spec Sections 2.4/3.1): stages this role's next duty/
    permission composition without touching what's live -- distinct from
    PUT /admin/roles/{id}/duties above, which applies immediately. Review
    the diff (GET .../diff) before POST .../publish makes it live."""
    with get_conn() as conn:
        if rbac_service.get_role(conn, role_id) is None:
            raise HTTPException(status_code=404, detail="Role not found")
        unknown = set(body.permissions) - rbac_service.VALID_PERMISSIONS
        if unknown:
            raise HTTPException(status_code=400, detail=f"Unknown permission(s): {', '.join(sorted(unknown))}")
        for duty_id in body.duty_ids:
            if rbac_service.get_duty(conn, duty_id) is None:
                raise HTTPException(status_code=404, detail=f"Duty {duty_id} not found")
        return rbac_service.save_role_draft(
            conn, role_id, body.duty_ids, body.permissions, user.get("badge_number", user.get("sub"))
        )


@app.get("/admin/roles/{role_id}/diff", response_model=RoleDiffOut)
def get_role_diff(role_id: int, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_role(conn, role_id) is None:
            raise HTTPException(status_code=404, detail="Role not found")
        return rbac_service.diff_role_draft(conn, role_id)


@app.post("/admin/roles/{role_id}/publish", response_model=RoleOut)
def publish_role(role_id: int, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_role(conn, role_id) is None:
            raise HTTPException(status_code=404, detail="Role not found")
        published = rbac_service.publish_role_draft(conn, role_id)
        if published is None:
            raise HTTPException(status_code=400, detail="No pending draft to publish")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "publish_role", "role", role_id)
        return _role_to_out(conn, published)


@app.post("/admin/roles/{role_id}/deactivate", response_model=RoleOut)
def deactivate_role(role_id: int, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_role(conn, role_id) is None:
            raise HTTPException(status_code=404, detail="Role not found")
        role = rbac_service.deactivate_role(conn, role_id)
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "deactivate_role", "role", role_id)
        return _role_to_out(conn, role)


@app.post("/admin/roles/{role_id}/reactivate", response_model=RoleOut)
def reactivate_role(role_id: int, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_role(conn, role_id) is None:
            raise HTTPException(status_code=404, detail="Role not found")
        role = rbac_service.reactivate_role(conn, role_id)
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "reactivate_role", "role", role_id)
        return _role_to_out(conn, role)


@app.delete("/admin/roles/{role_id}", status_code=204)
def delete_role_v2(role_id: int, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        try:
            deleted = rbac_service.delete_role(conn, role_id)
        except rbac_service.RoleInUseError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if not deleted:
            raise HTTPException(status_code=404, detail="Role not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete_role", "role", role_id)


@app.get("/admin/duties", response_model=list[DutyOut])
def list_duties(user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        return rbac_service.list_duties(conn)


@app.post("/admin/duties", response_model=DutyOut, status_code=201)
def create_duty(body: DutyCreate, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_duty_by_name(conn, body.name) is not None:
            raise HTTPException(status_code=409, detail=f"Duty '{body.name}' already exists")
        try:
            duty = rbac_service.create_duty(conn, body.name, body.display_name, body.description, body.permissions)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create_duty", "duty", duty["id"])
        return duty


@app.put("/admin/duties/{duty_id}", response_model=DutyOut)
def update_duty(duty_id: int, body: DutyUpdate, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_duty(conn, duty_id) is None:
            raise HTTPException(status_code=404, detail="Duty not found")
        try:
            duty = rbac_service.update_duty(
                conn, duty_id, display_name=body.display_name, description=body.description,
                permissions=body.permissions,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "edit_duty", "duty", duty_id)
        return duty


@app.get("/admin/diagnostics", response_model=DiagnosticsOut)
def get_diagnostics(
    permission: str, officer_id: int | None = None, role_id: int | None = None,
    user=Depends(require_permission("manage_roles")),
):
    """"Why does/doesn't this user have this access" (spec Section 3.5) --
    pick an officer (every role from their current active postings) or a
    role directly, and a permission; see exactly which role/duty grants it,
    or that nothing does."""
    if officer_id is None and role_id is None:
        raise HTTPException(status_code=400, detail="Provide officer_id or role_id")
    with get_conn() as conn:
        try:
            return admin_service.diagnose_permission(conn, permission, officer_id, role_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))


# Which permission gates import/export for a given entity_type (spec
# Section 3.7) -- generic across entity types, but each one still respects
# its own existing write permission rather than a single blanket import/
# export permission.
_DATA_JOB_ENTITY_PERMISSIONS = {
    "cameras": "manage_cameras", "officers": "manage_users_roles", "audit_logs": "view_audit_logs",
}


def _require_data_job_permission(user: dict, entity_type: str) -> None:
    required = _DATA_JOB_ENTITY_PERMISSIONS.get(entity_type)
    if required is None:
        raise HTTPException(status_code=400, detail=f"Unknown entity_type '{entity_type}'")
    if not has_permission(user, required):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


@app.post("/admin/data-jobs", response_model=DataJobOut, status_code=201)
def create_data_job(
    body: DataJobCreate, direction: str = Query(..., pattern="^(import|export)$"),
    user=Depends(get_current_user),
):
    _require_data_job_permission(user, body.entity_type)
    run_by = user.get("badge_number", user.get("sub", ""))
    with get_conn() as conn:
        try:
            if direction == "import":
                job = import_export_service.create_import_job(conn, body.entity_type, body.format, body.rows, run_by)
            else:
                job = import_export_service.export_entity(conn, body.entity_type, body.format, run_by)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        audit_service.log(
            conn, run_by, f"data_job_{direction}", "import_export_job", job["id"], reason_code=body.entity_type
        )
        return job


@app.get("/admin/data-jobs/{job_id}", response_model=DataJobOut)
def get_data_job(job_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        job = import_export_service.get_job(conn, job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        _require_data_job_permission(user, job["entity_type"])
        return job


@app.post("/admin/data-jobs/{job_id}/resubmit-failed", response_model=DataJobOut)
def resubmit_data_job(job_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        existing = import_export_service.get_job(conn, job_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Job not found")
        _require_data_job_permission(user, existing["entity_type"])
        job = import_export_service.resubmit_failed_rows(
            conn, job_id, user.get("badge_number", user.get("sub", ""))
        )
        audit_service.log(
            conn, user.get("badge_number", user.get("sub")), "data_job_resubmit", "import_export_job", job_id
        )
        return job


@app.get("/cameras")
def list_cameras(
    user=Depends(get_current_user),
    include_synthetic: bool = False,
    cursor: int | None = None,
    limit: int | None = None,
    min_lat: float | None = None,
    max_lat: float | None = None,
    min_long: float | None = None,
    max_long: float | None = None,
):
    # include_synthetic is the scale-demo surface -- gated behind the
    # environment kill-switch and manage_cameras (Super Admin/District
    # Command only, not every officer), so an ordinary officer can neither
    # see nor flood the synthetic registry. Real-camera pagination (cursor/
    # limit with include_synthetic left false) stays open to anyone
    # authenticated, same as today.
    if include_synthetic:
        require_scale_demo_enabled()
        if not has_permission(user, "manage_cameras"):
            raise HTTPException(status_code=403, detail="Insufficient permissions")

    with get_conn() as conn:
        # scope_type is only present on RBAC-issued tokens; legacy hand-crafted
        # tokens have no such claim and see every (real) camera, matching this
        # endpoint's behavior before pagination was added. A multi-posted
        # officer's effective jurisdiction is the union of every active
        # posting's district (spec Section 3.3) -- _effective_district_scopes
        # resolves that; _resolve_district_scoped applies it to the
        # single-district-filter cameras_service functions below.
        dept_scopes = _effective_district_scopes(user)

        # No pagination/synthetic params at all -> today's exact legacy behavior:
        # every real camera, as a bare list, no envelope. This is the path
        # CameraRegistryContext.tsx's fetchRegistryCameras() always takes.
        if cursor is None and limit is None and not include_synthetic:
            return _resolve_district_scoped(
                dept_scopes,
                lambda: cameras_service.list_cameras(conn, None),
                lambda d: cameras_service.list_cameras(conn, d),
            )

        bbox = None
        if None not in (min_lat, max_lat, min_long, max_long):
            bbox = (min_lat, max_lat, min_long, max_long)

        # Cursor pagination (the scale-demo surface) doesn't compose across
        # several districts' independent cursors -- a genuinely multi-posted
        # officer gets their first/primary district here rather than a true
        # cross-district merge; [] (no jurisdiction at all) short-circuits
        # to an empty page instead of silently falling back to unfiltered.
        # Every path past this point always returns list_cameras_page's
        # {"cameras": [...], "next_cursor": ...} envelope.
        if dept_scopes == []:
            return {"cameras": [], "next_cursor": None}
        page_dept = dept_scopes[0] if dept_scopes else None

        return cameras_service.list_cameras_page(
            conn,
            cursor=cursor,
            limit=limit or 100,
            include_synthetic=include_synthetic,
            dept=page_dept,
            bbox=bbox,
        )


@app.get("/cameras/summary")
def camera_summary(
    user=Depends(get_current_user),
    group_by: str | None = None,
    min_lat: float | None = None,
    max_lat: float | None = None,
    min_long: float | None = None,
    max_long: float | None = None,
):
    require_scale_demo_enabled()
    with get_conn() as conn:
        if group_by == "district":
            bbox = None
            if None not in (min_lat, max_lat, min_long, max_long):
                bbox = (min_lat, max_lat, min_long, max_long)
            return {"districts": cameras_service.get_district_summary(conn, bbox)}
        return cameras_service.get_summary(conn)


@app.get("/cameras/{camera_id}", response_model=CameraOut)
def get_camera(camera_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        camera = cameras_service.get_camera(conn, camera_id)
        if camera is None:
            raise HTTPException(status_code=404, detail="Camera not found")
        return camera


def _validate_circle_for_dept(conn, circle_id: int | None, dept: str) -> None:
    """Shared cross-district guard: a camera's circle_id (when set) must
    belong to a circle whose district matches the camera's own dept --
    otherwise the camera ends up "in" a circle that lives in a different
    district, which is the exact corrupted state the global constraint
    forbids. Raises HTTPException(404/400) same as the inline checks this
    replaces in create_camera/update_camera; also used by the bulk-import
    loop below."""
    if circle_id is None:
        return
    circle = circles_service.get_circle(conn, circle_id)
    if circle is None:
        raise HTTPException(status_code=404, detail="Circle not found")
    if circle["district"] != dept:
        raise HTTPException(status_code=400, detail="Circle belongs to a different district than this camera")


@app.post("/cameras", response_model=CameraOut, status_code=201)
def create_camera(camera: CameraCreate, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        _validate_circle_for_dept(conn, camera.circle_id, camera.dept)
        created = cameras_service.create_camera(conn, camera.model_dump())
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "camera", created["id"])
        return created


@app.post("/cameras/bulk", response_model=list[CameraBulkResult])
def create_cameras_bulk(cameras: list[dict], user=Depends(require_permission("manage_cameras"))):
    """Validates and inserts each row independently -- one bad row reports an
    error for its own index instead of failing the whole batch."""
    results = []
    with get_conn() as conn:
        for index, raw in enumerate(cameras):
            try:
                validated = CameraCreate(**raw)
            except ValidationError as e:
                reason = "; ".join(
                    f"{'.'.join(str(loc) for loc in err['loc'])}: {err['msg']}" for err in e.errors()
                )
                results.append(CameraBulkResult(index=index, status="error", reason=reason))
                continue

            try:
                _validate_circle_for_dept(conn, validated.circle_id, validated.dept)
            except HTTPException as e:
                results.append(CameraBulkResult(index=index, status="error", reason=str(e.detail)))
                continue

            try:
                created = cameras_service.create_camera(conn, validated.model_dump())
            except psycopg.Error as e:
                conn.rollback()
                results.append(CameraBulkResult(index=index, status="error", reason=str(e)))
                continue

            audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "camera", created["id"])
            results.append(CameraBulkResult(index=index, status="created", camera=created))
    return results


@app.get("/coverage-targets", response_model=list[CoverageTargetOut])
def list_coverage_targets(user=Depends(get_current_user)):
    with get_conn() as conn:
        return coverage_targets_service.list_targets(conn)


@app.get("/coverage-targets/{target_id}", response_model=CoverageTargetOut)
def get_coverage_target(target_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        target = coverage_targets_service.get_target(conn, target_id)
        if target is None:
            raise HTTPException(status_code=404, detail="Coverage target not found")
        return target


@app.post("/coverage-targets", response_model=CoverageTargetOut, status_code=201)
def create_coverage_target(body: CoverageTargetCreate, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        created = coverage_targets_service.create_target(conn, body.model_dump())
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "coverage_target", created["id"])
        return created


@app.put("/coverage-targets/{target_id}", response_model=CoverageTargetOut)
def update_coverage_target(target_id: int, body: CoverageTargetUpdate, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        updated = coverage_targets_service.update_target(conn, target_id, body.model_dump(exclude_unset=True))
        if updated is None:
            raise HTTPException(status_code=404, detail="Coverage target not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "update", "coverage_target", target_id)
        return updated


@app.delete("/coverage-targets/{target_id}", status_code=204)
def delete_coverage_target(target_id: int, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        deleted = coverage_targets_service.delete_target(conn, target_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Coverage target not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete", "coverage_target", target_id)


@app.get("/reports/gap-analysis", response_model=GapAnalysisReport)
def gap_analysis_report(
    threshold_m: int = 100,
    age_threshold_days: int = 1095,
    user=Depends(get_current_user),
):
    with get_conn() as conn:
        try:
            uncovered = gap_analysis_service.compute_uncovered_zones(conn, threshold_m)
        except psycopg.Error:
            conn.rollback()
            logger.error("gap-analysis: uncovered-zones computation failed", exc_info=True)
            uncovered = []
        try:
            ageing = gap_analysis_service.compute_ageing_infrastructure(conn, age_threshold_days)
        except psycopg.Error:
            conn.rollback()
            logger.error("gap-analysis: ageing-infrastructure computation failed", exc_info=True)
            ageing = []
        return {"uncovered_zones": uncovered, "ageing_infrastructure": ageing}


@app.get("/audit-logs", response_model=AuditLogsPage)
def list_audit_logs(
    badge_number: str | None = None,
    resource_type: str | None = None,
    category: str | None = None,
    camera_id: int | None = None,
    camera_district: str | None = None,
    camera_circle_id: int | None = None,
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    cursor: int | None = None,
    limit: int = Query(50, ge=1, le=200),
    user=Depends(require_permission("view_audit_logs")),
):
    # Same multi-posting jurisdiction union as list_cameras (spec Section
    # 3.3); cursor pagination doesn't compose across several districts, so a
    # genuinely multi-posted officer's primary district is used here rather
    # than a true cross-district merge -- [] (no jurisdiction) returns an
    # empty page instead of silently falling back to unfiltered.
    dept_scopes = _effective_district_scopes(user)
    if dept_scopes == []:
        return {"logs": [], "next_cursor": None}
    district = dept_scopes[0] if dept_scopes else None
    with get_conn() as conn:
        logs, next_cursor = audit_logs_service.list_logs(
            conn, badge_number, resource_type, category, camera_id, camera_district, camera_circle_id,
            date_from, date_to, district, cursor, limit,
        )
        return {"logs": logs, "next_cursor": next_cursor}


@app.get("/audit-logs/categories")
def list_audit_log_categories(user=Depends(require_permission("view_audit_logs"))):
    """Backs the category filter chips -- keeps the frontend from having to
    duplicate the action/resource_type -> category mapping (single source of
    truth stays audit_logs_service.CATEGORIES)."""
    return {"categories": list(audit_logs_service.CATEGORIES.keys()) + ["other"]}


@app.get("/police-stations", response_model=list[PoliceStationOut])
def list_police_stations(user=Depends(get_current_user)):
    with get_conn() as conn:
        return police_stations_service.list_stations(conn)


@app.get("/police-stations/{station_id}", response_model=PoliceStationOut)
def get_police_station(station_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        station = police_stations_service.get_station(conn, station_id)
        if station is None:
            raise HTTPException(status_code=404, detail="Police station not found")
        return station


@app.post("/police-stations", response_model=PoliceStationOut, status_code=201)
def create_police_station(body: PoliceStationCreate, user=Depends(require_permission("manage_stations"))):
    with get_conn() as conn:
        created = police_stations_service.create_station(conn, body.model_dump())
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "police_station", created["id"])
        return created


@app.put("/police-stations/{station_id}", response_model=PoliceStationOut)
def update_police_station(station_id: int, body: PoliceStationUpdate, user=Depends(require_permission("manage_stations"))):
    with get_conn() as conn:
        updated = police_stations_service.update_station(conn, station_id, body.model_dump(exclude_unset=True))
        if updated is None:
            raise HTTPException(status_code=404, detail="Police station not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "update", "police_station", station_id)
        return updated


@app.delete("/police-stations/{station_id}", status_code=204)
def delete_police_station(station_id: int, user=Depends(require_permission("manage_stations"))):
    with get_conn() as conn:
        deleted = police_stations_service.delete_station(conn, station_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Police station not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete", "police_station", station_id)


def _guard_circle_district(user: dict, district: str):
    """District-scoped users may only create/edit/delete circles in one of
    their own effective jurisdictions -- the union of every active
    posting's district (spec Section 3.3) -- same guard create_posting
    already applies for postings."""
    scopes = _effective_district_scopes(user)
    if scopes is not None and district not in scopes:
        raise HTTPException(status_code=403, detail="Cannot manage circles outside your own district")


@app.get("/circles", response_model=list[CircleOut])
def list_circles(user=Depends(get_current_user)):
    with get_conn() as conn:
        return _resolve_district_scoped(
            _effective_district_scopes(user),
            lambda: circles_service.list_circles(conn, None),
            lambda d: circles_service.list_circles(conn, d),
        )


@app.get("/circles/{circle_id}", response_model=CircleOut)
def get_circle(circle_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        circle = circles_service.get_circle(conn, circle_id)
        if circle is None:
            raise HTTPException(status_code=404, detail="Circle not found")
        return circle


@app.post("/circles", response_model=CircleOut, status_code=201)
def create_circle(body: CircleCreate, user=Depends(require_permission("manage_circles"))):
    _guard_circle_district(user, body.district)
    with get_conn() as conn:
        try:
            created = circles_service.create_circle(conn, body.model_dump())
        except circles_service.DuplicateCircleError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "circle", created["id"])
        return created


@app.put("/circles/{circle_id}", response_model=CircleOut)
def update_circle(circle_id: int, body: CircleUpdate, user=Depends(require_permission("manage_circles"))):
    with get_conn() as conn:
        existing = circles_service.get_circle(conn, circle_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Circle not found")
        _guard_circle_district(user, existing["district"])
        if body.district is not None:
            _guard_circle_district(user, body.district)
            if body.district != existing["district"] and circles_service.camera_count_for_circle(conn, circle_id) > 0:
                raise HTTPException(
                    status_code=400,
                    detail="Cannot change district of a circle that still has cameras assigned",
                )
        try:
            updated = circles_service.update_circle(conn, circle_id, body.model_dump(exclude_unset=True))
        except circles_service.DuplicateCircleError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "update", "circle", circle_id)
        return updated


@app.delete("/circles/{circle_id}", status_code=204)
def delete_circle(circle_id: int, user=Depends(require_permission("manage_circles"))):
    with get_conn() as conn:
        existing = circles_service.get_circle(conn, circle_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Circle not found")
        _guard_circle_district(user, existing["district"])
        try:
            deleted = circles_service.delete_circle(conn, circle_id)
        except circles_service.CircleInUseError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if not deleted:
            raise HTTPException(status_code=404, detail="Circle not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete", "circle", circle_id)


@app.get("/reports/summary", response_model=ReportSummary)
def reports_summary(user=Depends(get_current_user)):
    with get_conn() as conn:
        summary = reports_service.get_summary(conn)
        return summary


@app.put("/cameras/{camera_id}", response_model=CameraOut)
def update_camera(camera_id: int, camera: CameraUpdate, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        fields = camera.model_dump(exclude_unset=True)
        if "circle_id" in fields or "dept" in fields:
            existing = cameras_service.get_camera(conn, camera_id)
            if existing is None:
                raise HTTPException(status_code=404, detail="Camera not found")
            effective_circle_id = fields.get("circle_id", existing.get("circle_id"))
            effective_dept = fields.get("dept", existing["dept"])
            _validate_circle_for_dept(conn, effective_circle_id, effective_dept)

        updated, connectivity_changed = cameras_service.update_camera(conn, camera_id, fields)
        if updated is None:
            raise HTTPException(status_code=404, detail="Camera not found")

        non_connectivity_fields = {k for k in fields if k != "connectivity_status"}
        if non_connectivity_fields:
            audit_service.log(conn, user.get("badge_number", user.get("sub")), "update", "camera", camera_id)
        if connectivity_changed:
            logger.info(f"camera {camera_id} connectivity changed to '{updated['connectivity_status']}'")

        return updated


@app.get("/cameras/{camera_id}/uptime", response_model=CameraUptimeReport)
def camera_uptime(camera_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        camera = cameras_service.get_camera(conn, camera_id)
        if camera is None:
            raise HTTPException(status_code=404, detail="Camera not found")
        windows = cameras_service.get_uptime_windows(conn, camera_id)
        return {
            "camera_id": camera_id,
            "current_status": camera["connectivity_status"],
            "windows": windows,
        }


@app.get("/snmp/devices")
def snmp_devices(user=Depends(get_current_user)):
    return snmp_service.get_devices()


@app.get("/cameras/{camera_id}/health")
def camera_snmp_health(camera_id: int, user=Depends(get_current_user)):
    device = snmp_service.get_device_for_camera(camera_id)
    if device is None:
        raise HTTPException(status_code=404, detail="No SNMP health data available for this camera")
    return device


@app.get("/cameras/{camera_id}/recordings")
def camera_recordings(camera_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        camera = cameras_service.get_camera(conn, camera_id)
        if camera is None:
            raise HTTPException(status_code=404, detail="Camera not found")
        if not camera["stream_id"]:
            return {"available": False, "segments": []}
        return recordings_service.list_recordings(camera["stream_id"])


@app.delete("/cameras/{camera_id}", status_code=204)
def delete_camera(camera_id: int, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        deleted = cameras_service.delete_camera(conn, camera_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Camera not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete", "camera", camera_id)


@app.post("/synthetic/detections", response_model=SyntheticDetectionEventAccepted, status_code=202)
def receive_synthetic_detection(
    body: SyntheticDetectionEventIn, background_tasks: BackgroundTasks, user=Depends(get_current_user)
):
    require_scale_demo_enabled()
    if not has_permission(user, "manage_cameras"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    def _write():
        # Runs after the 202 has already gone out -- the client can't be told
        # about a failure here, so a broad catch is intentional (a pool
        # timeout, a bad payload, anything) rather than picking one exception
        # type to handle and letting the rest crash the background task
        # silently. No retry (out of scope) -- this just makes the failure
        # observable instead of a silently dropped event.
        try:
            with get_conn() as conn:
                synthetic_events_service.record_event(conn, body.event_id, body.camera_id, body.edge_node_id, body.payload)
        except Exception:  # noqa: BLE001 -- deliberate catch-all, see comment above
            logger.error(f"failed to write synthetic detection event {body.event_id}", exc_info=True)

    background_tasks.add_task(_write)
    return {"event_id": body.event_id, "status": "accepted"}
