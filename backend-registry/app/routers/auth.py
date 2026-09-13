"""Officer authentication and self-service profile: login (with mandatory
email 2FA), self-registration (with mandatory email verification, since
there's no admin approval step left to wait through -- see
routers/registration_admin.py for the manual override), password reset via
emailed OTP, and the small set of "edit my own account" actions
(profile photo, 2FA email). Password changes always go through the
emailed-OTP reset flow below (request-password-reset-otp /
reset-password-with-otp) -- there is no separate "type your current
password to set a new one" endpoint."""
import jwt
from fastapi import APIRouter, Depends, HTTPException

from ..auth import get_current_user
from ..db import get_conn
from ..logging_config import logger
from ..schemas import (
    EmailUpdateRequest,
    LoginRequest,
    LoginResponse,
    MeResponse,
    ProfilePhotoUpdate,
    RegisterRequest,
    RegisterResponse,
    RequestPasswordResetOtpBody,
    ResetPasswordWithOtpBody,
    VerifyEmailRequest,
    VerifyLoginOtpRequest,
    VerifyLoginOtpResponse,
    VerifyRegistrationRequest,
)
from ..services import (
    admin_service,
    audit_service,
    auth_service,
    email_otp_service,
    email_service,
    locations_service,
    password_policy_service,
    rbac_service,
    registration_service,
    sessions_service,
    trusted_devices_service,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=LoginResponse)
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

        # Email 2FA is opt-in (see schema.sql's comment on officers.email) --
        # an officer with no email on file logs in exactly as before this
        # feature existed. One who has set an email skips the OTP step only
        # when the request presents a device_token this exact officer
        # previously chose to remember (see LoginResponse.otp_required).
        if officer["email"] and not (
            body.device_token and trusted_devices_service.is_trusted(conn, officer["id"], body.device_token)
        ):
            try:
                email_otp_service.request_otp(conn, officer["id"], officer["email"], "login_2fa")
            except email_service.EmailSendError as exc:
                # A misconfigured/down Resend must never silently lock an
                # officer out with no explanation -- log the real cause,
                # tell the officer plainly rather than a raw 500.
                logger.error("Failed to send login-2FA email to officer %s: %s", officer["id"], exc)
                raise HTTPException(status_code=503, detail="Couldn't send your verification code -- please try again shortly")
            return {"otp_required": True, "pending_token": auth_service.issue_pending_login_token(officer["id"])}

        # 'pending' (a freshly self-registered officer, spec Section 3.2) and
        # 'active' both reach here -- a pending officer still gets a token,
        # just one carrying zero postings/permissions, so the frontend can
        # show the "awaiting approval" empty shell instead of a login error.
        postings = auth_service.get_active_postings(conn, officer["id"])
        token = auth_service.issue_token(conn, officer, postings)
        auth_service.record_successful_login(conn, officer["id"])
        audit_service.log(conn, officer["badge_number"], "login", "officer", officer["id"], badge_number=officer["badge_number"])
        return {"token": token}


@router.post("/verify-login-otp", response_model=VerifyLoginOtpResponse)
def verify_login_otp(body: VerifyLoginOtpRequest):
    try:
        officer_id = auth_service.decode_pending_login_token(body.pending_token)
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="This login attempt has expired -- please log in again")

    with get_conn() as conn:
        officer = auth_service.get_officer_by_id(conn, officer_id)
        # The pending token's officer_id refers to a real row (this route
        # never issues one otherwise), but re-check status/lockout here too
        # -- an admin could suspend or lock the account in the 10-minute
        # window between POST /auth/login and this call.
        if officer is None or officer["status"] in ("suspended", "deactivated"):
            raise HTTPException(status_code=403, detail="This account can no longer log in")
        if auth_service.is_locked(officer):
            raise HTTPException(status_code=423, detail="Account is locked due to too many failed login attempts")

        if not email_otp_service.verify_otp(conn, officer_id, "login_2fa", body.code):
            raise HTTPException(status_code=401, detail="Incorrect or expired code")

        postings = auth_service.get_active_postings(conn, officer["id"])
        token = auth_service.issue_token(conn, officer, postings)
        auth_service.record_successful_login(conn, officer["id"])
        audit_service.log(
            conn, officer["badge_number"], "login", "officer", officer["id"], badge_number=officer["badge_number"]
        )

        device_token = None
        if body.remember_device:
            device_token = trusted_devices_service.generate_device_token()
            trusted_devices_service.register_device(conn, officer["id"], device_token)

        return {"token": token, "device_token": device_token}


@router.post("/request-password-reset-otp")
def request_password_reset_otp(body: RequestPasswordResetOtpBody):
    # Always the same generic response regardless of whether the badge
    # number exists or has an email on file -- an attacker probing badge
    # numbers must never be able to tell which ones are real from this
    # endpoint's response alone (same user-enumeration concern the existing
    # constant-time login check exists for).
    generic_response = {"message": "If that account exists and has an email on file, a reset code was sent."}
    with get_conn() as conn:
        officer = auth_service.get_officer_by_badge(conn, body.badge_number)
        if officer is not None and officer["email"]:
            try:
                email_otp_service.request_otp(conn, officer["id"], officer["email"], "password_reset")
            except email_service.EmailSendError as exc:
                # Logged, not surfaced -- the generic response above must
                # stay identical whether the account exists, has no email,
                # or the send itself failed, or an attacker could use the
                # difference to enumerate accounts.
                logger.error("Failed to send password-reset email to officer %s: %s", officer["id"], exc)
    return generic_response


@router.post("/reset-password-with-otp")
def reset_password_with_otp(body: ResetPasswordWithOtpBody):
    with get_conn() as conn:
        officer = auth_service.get_officer_by_badge(conn, body.badge_number)
        # Same "don't reveal whether the badge number exists" reasoning as
        # the request endpoint above -- an unknown badge or one with no
        # email on file gets the same 401 an existing-but-wrong-code attempt
        # would, not a distinct "no such account" error.
        if officer is None or not officer["email"]:
            raise HTTPException(status_code=401, detail="Incorrect or expired code")

        if not email_otp_service.verify_otp(conn, officer["id"], "password_reset", body.code):
            raise HTTPException(status_code=401, detail="Incorrect or expired code")

        try:
            password_policy_service.validate_password_or_raise(
                body.new_password, user_inputs=[officer["badge_number"], officer["name"]]
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        auth_service.set_password(conn, officer["id"], auth_service.hash_password(body.new_password))
        # A password reset force-logs-out every other session -- if someone
        # else had the old password, this is the point that shuts them out,
        # same security bar as an admin-initiated reset already has via
        # POST /admin/officers/{id}/reset-password.
        sessions_service.revoke_all_sessions(conn, officer["id"])
        audit_service.log(
            conn, officer["badge_number"], "self_service_password_reset", "officer", officer["id"],
            badge_number=officer["badge_number"],
        )
    return {"message": "Password reset. Please log in with your new password."}


@router.put("/me/email")
def update_my_email(body: EmailUpdateRequest, user=Depends(get_current_user)):
    """2FA is mandatory (see RegisterRequest.email), so this only ever
    changes the address -- it can never clear it. Requires proving control
    of the new inbox first: this returns a pending_token and sends an OTP
    to the CANDIDATE address, and nothing is written to officers.email
    until POST /auth/me/email/verify succeeds with the right code."""
    officer_id = user.get("sub")
    if not officer_id or not str(officer_id).isdigit():
        raise HTTPException(status_code=400, detail="This session has no officer account to update")
    with get_conn() as conn:
        officer = auth_service.get_officer_by_id(conn, int(officer_id))
        if officer is None:
            raise HTTPException(status_code=404, detail="Officer not found")
        if not auth_service.verify_password(body.current_password, officer["password_hash"]):
            raise HTTPException(status_code=401, detail="Current password is incorrect")

        try:
            email_otp_service.request_otp(conn, officer["id"], body.email, "email_verification")
        except email_service.EmailSendError as exc:
            logger.error("Failed to send email-verification code to officer %s: %s", officer["id"], exc)
            raise HTTPException(status_code=503, detail="Couldn't send a verification code -- please try again shortly")

        return {
            "verification_required": True,
            "pending_token": auth_service.issue_pending_email_verification_token(officer["id"], body.email),
        }


@router.post("/me/email/verify", response_model=MeResponse)
def verify_my_email(body: VerifyEmailRequest, user=Depends(get_current_user)):
    try:
        token_officer_id, candidate_email = auth_service.decode_pending_email_verification_token(body.pending_token)
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="This verification attempt has expired -- start again")

    officer_id = user.get("sub")
    # The pending token is bound to whichever officer requested it -- a
    # session belonging to someone else presenting it (even a valid,
    # unexpired token) must not be able to claim it.
    if not officer_id or not str(officer_id).isdigit() or int(officer_id) != token_officer_id:
        raise HTTPException(status_code=403, detail="This verification attempt does not belong to your session")

    with get_conn() as conn:
        officer = auth_service.get_officer_by_id(conn, token_officer_id)
        if officer is None:
            raise HTTPException(status_code=404, detail="Officer not found")
        if not email_otp_service.verify_otp(conn, token_officer_id, "email_verification", body.code):
            raise HTTPException(status_code=401, detail="Incorrect or expired code")

        auth_service.set_email(conn, officer["id"], candidate_email)
        audit_service.log(
            conn, officer["badge_number"], "update_email", "officer", officer["id"], badge_number=officer["badge_number"]
        )
        return me(user)


@router.get("/me", response_model=MeResponse)
def me(user=Depends(get_current_user)):
    response = {
        "badge_number": user.get("badge_number", user.get("sub", "")),
        "name": user.get("name", ""),
        "role": user.get("role", ""),
        "rank": None,
        "photo_url": None,
        "email": None,
        "contact_info": None,
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
                response["email"] = officer["email"]
                response["contact_info"] = officer["contact_info"]
                response["last_login"] = auth_service.get_last_login(conn, officer["id"])
                # 'pending' is the only status that ever reaches here with a
                # valid token (suspended/deactivated are rejected at login) --
                # this is the frontend's signal to show the "awaiting
                # approval" empty shell instead of the normal dashboard.
                response["status"] = officer["status"]
    return response


@router.post("/register", response_model=RegisterResponse, status_code=201)
def register(body: RegisterRequest):
    """Public self-registration. Creates the officer row immediately,
    status='pending', with zero postings -- but there is no admin approval
    step left to wait through: POST /auth/register/verify (with the OTP
    just emailed) both proves this is a real inbox the registrant controls
    and activates the account with a baseline posting in one step. No
    permission gate -- this is the one endpoint meant for someone who isn't
    an officer yet.

    If the verification email itself fails to send, the officer row still
    exists (status stays 'pending' forever, with no resend endpoint yet) --
    an accepted rough edge for now, not a rollback of the whole request."""
    with get_conn() as conn:
        if auth_service.get_officer_by_badge(conn, body.badge_number) is not None:
            raise HTTPException(status_code=409, detail="Badge number already registered")
        # The frontend now offers this as a dropdown populated from the same
        # canonical list, but the server can't trust that a client actually
        # used it -- a free-typed or replayed request must still match a
        # real district, since this becomes the officer's own posting scope
        # the moment they verify (see register/verify below), with no admin
        # left in the loop to catch a typo.
        if not locations_service.district_exists(conn, body.department):
            raise HTTPException(status_code=400, detail="Department/District must be a valid Gujarat district")
        try:
            password_policy_service.validate_password_or_raise(
                body.password, user_inputs=[body.badge_number, body.name, body.email]
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO officers (badge_number, name, rank, password_hash, email, contact_info, status) "
                "VALUES (%s, %s, %s, %s, %s, %s, 'pending') RETURNING id",
                (
                    body.badge_number,
                    body.name,
                    body.rank,
                    auth_service.hash_password(body.password),
                    body.email,
                    body.contact_info,
                ),
            )
            officer_id = cur.fetchone()[0]
        conn.commit()
        registration_service.create_request(conn, officer_id, body.department, body.contact_info)
        audit_service.log(conn, body.badge_number, "self_register", "officer", officer_id, badge_number=body.badge_number)

        try:
            email_otp_service.request_otp(conn, officer_id, body.email, "email_verification")
        except email_service.EmailSendError as exc:
            logger.error("Failed to send registration-verification code to officer %s: %s", officer_id, exc)
            raise HTTPException(status_code=503, detail="Couldn't send a verification code -- please try again shortly")

        return {"pending_token": auth_service.issue_pending_email_verification_token(officer_id, body.email)}


@router.post("/register/verify", response_model=LoginResponse)
def verify_registration(body: VerifyRegistrationRequest):
    """Verifying the OTP proves the registrant controls the email they
    registered with, assigns their baseline posting (station_officer,
    scoped to the district they gave at registration -- there's no admin
    left to choose one), activates the account, and logs them straight in."""
    try:
        officer_id, _candidate_email = auth_service.decode_pending_email_verification_token(body.pending_token)
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="This verification attempt has expired -- please register again")

    with get_conn() as conn:
        officer = auth_service.get_officer_by_id(conn, officer_id)
        if officer is None or officer["status"] != "pending":
            raise HTTPException(status_code=404, detail="Registration not found or already verified")

        if not email_otp_service.verify_otp(conn, officer_id, "email_verification", body.code):
            raise HTTPException(status_code=401, detail="Incorrect or expired code")

        pending = registration_service.get_pending_request_for_officer(conn, officer_id)
        request = registration_service.get_request(conn, pending["id"]) if pending else None
        role = rbac_service.get_role_by_name(conn, "station_officer")
        admin_service.add_posting(
            conn, officer_id, role["id"], "district", request["department"] if request else None,
            assigned_by="auto:email-verified",
        )
        admin_service.set_officer_status(conn, officer_id, "active")
        if request:
            registration_service.mark_approved(conn, request["id"], "auto:email-verified")
        audit_service.log(conn, officer["badge_number"], "self_register_verified", "officer", officer_id)

        postings = auth_service.get_active_postings(conn, officer_id)
        token = auth_service.issue_token(conn, officer, postings)
        auth_service.record_successful_login(conn, officer_id)
        return {"token": token}


@router.put("/me/photo", response_model=MeResponse)
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
