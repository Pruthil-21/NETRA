"""Pydantic request/response models for the cameras API.

Field names match /contract/API_CONTRACT.md exactly.
"""
import re
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

# email-validator (pydantic's EmailStr) isn't a project dependency -- a
# lightweight format check here avoids adding one just for this.
_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _validate_email_format(value: str) -> str:
    value = value.strip()
    if not _EMAIL_PATTERN.match(value):
        raise ValueError("Enter a valid email address")
    return value


# FIWARE/IUDX Smart Data Models `Camera` schema's real cameraUsage enum
# (dataModel.Device/Camera) -- not DB-enforced (see schema.sql), just the
# suggested/documented set. A value outside this list is still accepted:
# real deployments outgrow a fixed enum faster than a schema migration.
SUGGESTED_CAMERA_USAGE = ("SURVEILLANCE", "RLVD", "ANPR_LPR", "TRAFFIC")

# The five departments the problem statement's own dataset actually spans
# (FAQ #39: "cameras deployed across five Government departments: Health,
# Police, GSRTC, Panchayat, and Municipal Corporation") -- the suggested,
# not enforced, set for owning_department. The real statewide deployment
# names 26 departments total (FAQ #3); this is deliberately not a closed
# enum for that reason.
SUGGESTED_OWNING_DEPARTMENTS = ("Police", "GSRTC", "Panchayat", "Municipal Corporation", "Health")


class CameraCreate(BaseModel):
    name: str
    dept: str
    lat: float
    long: float
    camera_type: str
    ownership: str
    connectivity_status: str = "unknown"
    storage_type: str
    retention_days: int
    health_status: str = "unknown"
    rtsp_url: Optional[str] = None
    # Playback identity, decoupled from the registry's own `id` — see schema.sql.
    stream_id: Optional[str] = None
    hls_url: Optional[str] = None
    area_id: Optional[int] = None
    # IUDX/FIWARE alignment, CMDB lifecycle, DPDP documentation -- all
    # optional/defaulted so every existing caller (bulk CSV import, the
    # scale-demo seed scripts, the Add Camera modal) keeps working unchanged.
    camera_usage: Optional[str] = None
    lifecycle_stage: str = "operational"
    lawful_basis: Optional[str] = None
    privacy_review_completed: bool = False
    # The owning GOVERNMENT DEPARTMENT (Police/GSRTC/Panchayat/Municipal
    # Corporation/Health/...) -- distinct from `dept` above, which is the
    # owning city/district. See schema.sql's owning_department column
    # comment for why these are two separate fields, not one.
    owning_department: Optional[str] = None


class CameraUpdate(BaseModel):
    name: Optional[str] = None
    dept: Optional[str] = None
    lat: Optional[float] = None
    long: Optional[float] = None
    camera_type: Optional[str] = None
    ownership: Optional[str] = None
    connectivity_status: Optional[str] = None
    storage_type: Optional[str] = None
    retention_days: Optional[int] = None
    health_status: Optional[str] = None
    rtsp_url: Optional[str] = None
    stream_id: Optional[str] = None
    hls_url: Optional[str] = None
    area_id: Optional[int] = None
    camera_usage: Optional[str] = None
    lifecycle_stage: Optional[str] = None
    lawful_basis: Optional[str] = None
    privacy_review_completed: Optional[bool] = None
    owning_department: Optional[str] = None


class CameraOut(CameraCreate):
    id: int


class CameraBulkResult(BaseModel):
    """One row's outcome from POST /cameras/bulk — a bad row never fails the
    whole batch, so the caller needs a per-row success/failure verdict."""
    index: int
    status: Literal["created", "error"]
    camera: Optional[CameraOut] = None
    reason: Optional[str] = None


class UptimeWindow(BaseModel):
    status: str
    from_: datetime = Field(alias="from")
    to: Optional[datetime] = None
    duration_seconds: float

    model_config = {"populate_by_name": True}


class CameraUptimeReport(BaseModel):
    camera_id: int
    current_status: str
    windows: list[UptimeWindow]


class ReportSummary(BaseModel):
    total_cameras: int
    cameras_by_department: dict[str, int]
    cameras_by_connectivity_status: dict[str, int]
    cameras_by_health_status: dict[str, int]
    # None when backend-watchlist's schema hasn't been applied yet in this
    # environment — see reports_service._count_last_24h.
    alerts_last_24h: Optional[int] = None
    detections_last_24h: Optional[int] = None
    blacklist_entries_last_24h: Optional[int] = None
    avg_alert_response_seconds: Optional[float] = None


class LoginRequest(BaseModel):
    badge_number: str
    password: str
    # Presented back by a browser this officer previously chose to "remember"
    # (see LoginResponse.device_token) -- lets login skip the OTP step below
    # entirely when it matches a real, unexpired trusted_devices row for this
    # officer. Omitted/wrong/expired: login proceeds exactly as if 2FA were
    # being triggered for the first time on this device.
    device_token: Optional[str] = None


class LoginResponse(BaseModel):
    # Exactly one of (token) or (otp_required + pending_token) is set: a
    # trusted device or an officer with no email on file gets `token`
    # straight away, same as before this feature existed; anyone else gets
    # otp_required=True and must call POST /auth/verify-login-otp with
    # `pending_token` to actually get a token.
    token: Optional[str] = None
    otp_required: bool = False
    pending_token: Optional[str] = None


class VerifyLoginOtpRequest(BaseModel):
    pending_token: str
    code: str
    remember_device: bool = False


class VerifyLoginOtpResponse(BaseModel):
    token: str
    # Present only when the request asked to remember this device -- the
    # client stores it (localStorage, not sessionStorage: it must outlive
    # this one session) and sends it back as LoginRequest.device_token on
    # future logins.
    device_token: Optional[str] = None


class RequestPasswordResetOtpBody(BaseModel):
    badge_number: str


class ResetPasswordWithOtpBody(BaseModel):
    badge_number: str
    code: str
    new_password: str


class EmailUpdateRequest(BaseModel):
    # Required -- 2FA is mandatory from registration onward (see
    # RegisterRequest.email), so there is no longer a supported way to
    # clear an officer's email and fall back to password-only login.
    email: str
    # Changing the address 2FA codes and reset codes go to is security-
    # relevant enough to require re-proving the password -- not just
    # "already holds a valid session JWT."
    current_password: str

    @field_validator("email")
    @classmethod
    def _valid_email(cls, value):
        return _validate_email_format(value)


class EmailUpdateResponse(BaseModel):
    """Response for PUT /auth/me/email when `email` was non-null -- nothing
    is written to officers.email yet, the officer must prove they actually
    control that inbox first via POST /auth/me/email/verify. Clearing the
    email (email=None) skips this entirely and returns MeResponse directly,
    same as before this feature existed -- there's no ownership to prove
    when turning 2FA off."""
    verification_required: bool = True
    pending_token: str


class VerifyEmailRequest(BaseModel):
    pending_token: str
    code: str


class MeResponse(BaseModel):
    badge_number: str
    name: str
    role: Optional[str] = None
    rank: Optional[str] = None
    photo_url: Optional[str] = None
    # Set only via PUT /auth/me/email -- non-None is exactly what "login 2FA
    # and self-service password reset are on for this officer" means (see
    # schema.sql's comment above officers.email).
    email: Optional[str] = None
    contact_info: Optional[str] = None
    last_login: Optional[datetime] = None
    status: str = "active"
    scope_type: Optional[str] = None
    scope_value: Optional[str] = None
    permissions: list[str]


class PasswordResetBody(BaseModel):
    new_password: str


class ProfilePhotoUpdate(BaseModel):
    photo_url: Optional[str] = None


class PostingSummary(BaseModel):
    id: int
    role: str
    scope_type: str
    scope_value: Optional[str] = None


class OfficerOut(BaseModel):
    id: int
    badge_number: str
    name: str
    rank: Optional[str] = None
    active_posting: Optional[PostingSummary] = None
    # An officer can hold several simultaneously-active postings (spec
    # Section 3.3) -- active_posting (singular) is kept for callers that
    # only ever showed one; this is the full set.
    active_postings: list[PostingSummary] = []


class PostingOut(BaseModel):
    id: int
    officer_id: int
    role: str
    scope_type: str
    scope_value: Optional[str] = None
    is_active: bool


class PostingCreate(BaseModel):
    officer_id: int
    role_name: str
    scope_type: str
    scope_value: Optional[str] = None
    expires_at: Optional[datetime] = None


class RolePermissionsOut(BaseModel):
    id: int
    name: str
    display_name: str
    hierarchy_level: Optional[int] = None
    permissions: list[str]
    parent_role_id: Optional[int] = None
    is_active: bool = True
    is_system: bool = False
    duty_ids: list[int] = []


class RolePermissionsUpdate(BaseModel):
    permissions: list[str]
    reason_code: Optional[str] = None


class DutyCreate(BaseModel):
    name: str
    display_name: str
    description: Optional[str] = None
    permissions: list[str] = []


class DutyUpdate(BaseModel):
    display_name: Optional[str] = None
    description: Optional[str] = None
    permissions: Optional[list[str]] = None


class DutyOut(BaseModel):
    id: int
    name: str
    display_name: str
    description: Optional[str] = None
    permissions: list[str]


class RoleOut(BaseModel):
    id: int
    name: str
    display_name: str
    hierarchy_level: Optional[int] = None
    can_delegate_admin: bool
    parent_role_id: Optional[int] = None
    is_active: bool
    is_system: bool
    duty_ids: list[int] = []
    # Direct role_permissions only (the rare/advanced path) -- callers that
    # need the full effective set (duties included) use
    # GET /admin/roles/{id}/effective-permissions.
    permissions: list[str] = []


class RoleCreate(BaseModel):
    name: str
    display_name: str
    hierarchy_level: Optional[int] = None
    can_delegate_admin: bool = False
    parent_role_id: Optional[int] = None
    duty_ids: list[int] = []
    permissions: list[str] = []


class RoleCloneRequest(BaseModel):
    name: str
    display_name: str


class RoleDutiesUpdate(BaseModel):
    duty_ids: list[int]


class RoleDraftUpdate(BaseModel):
    duty_ids: list[int] = []
    permissions: list[str] = []


class RoleDraftOut(BaseModel):
    role_id: int
    draft_duty_ids: list[int]
    draft_permissions: list[str]
    created_by: Optional[str] = None
    created_at: datetime


class RoleDiffOut(BaseModel):
    role_id: int
    has_draft: bool
    added_permissions: list[str] = []
    removed_permissions: list[str] = []
    affected_active_holders: int


class EffectivePermissionsOut(BaseModel):
    role_id: int
    permissions: list[str]


class RegisterRequest(BaseModel):
    badge_number: str
    name: str
    rank: Optional[str] = None
    # Required now (was optional): this becomes the officer's initial
    # posting's district scope the moment their email verifies -- there is
    # no admin left in the loop to supply one, so it can't be missing (see
    # POST /auth/register/verify).
    department: str = Field(min_length=1)
    # The account's email from day one -- proving control of it (via the
    # OTP sent at registration) is what replaces admin approval as the
    # activation gate, and it doubles as this officer's 2FA email with no
    # separate setup step needed.
    email: str
    # Required now (was optional): stored permanently on the officer's own
    # record from registration onward (see schema.sql's officers.contact_info)
    # and displayed on their profile -- an officer with no phone on file has
    # no channel to reach them outside the app itself.
    contact_info: str = Field(min_length=1)
    password: str

    @field_validator("email")
    @classmethod
    def _valid_email(cls, value):
        return _validate_email_format(value)


class RegisterResponse(BaseModel):
    """Response for POST /auth/register -- registration no longer activates
    the account by itself; POST /auth/register/verify (with the OTP just
    emailed) does that."""
    pending_token: str


class VerifyRegistrationRequest(BaseModel):
    pending_token: str
    code: str


class RegistrationRequestOut(BaseModel):
    id: int
    officer_id: int
    badge_number: str
    name: str
    rank: Optional[str] = None
    department: Optional[str] = None
    contact_info: Optional[str] = None
    status: str
    reviewed_by: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    rejection_reason: Optional[str] = None
    created_at: datetime


class RegistrationApprove(BaseModel):
    role_name: str
    scope_type: str
    scope_value: Optional[str] = None


class RegistrationReject(BaseModel):
    reason: Optional[str] = None


class DataJobCreate(BaseModel):
    entity_type: str
    format: Literal["csv", "json", "xlsx"] = "json"
    # Pre-parsed rows for an import job (a raw CSV/XLSX file is parsed into
    # this shape before it reaches this endpoint) -- absent/ignored for an
    # export job, which reads the entity's current rows instead.
    rows: list[dict] = []
    # Export-only: entity-specific narrowing (district, date_from/date_to,
    # status, category, ...) -- each entity's own export handler in
    # import_export_service.py reads only the keys it understands from
    # this, so the shape isn't validated more strictly than "a dict" here.
    filters: dict = {}


class DataJobOut(BaseModel):
    id: int
    entity_type: str
    direction: str
    format: str
    status: str
    total_rows: int
    success_rows: int
    failed_rows: int
    row_results: Optional[list[dict]] = None
    filters: Optional[dict] = None
    run_by: Optional[str] = None
    created_at: datetime


class NotificationOut(BaseModel):
    id: int
    officer_id: int
    type: str
    message: str
    read: bool
    created_at: datetime


class OfficerProfileOut(BaseModel):
    id: int
    badge_number: str
    name: str
    rank: Optional[str] = None
    photo_url: Optional[str] = None
    status: str
    last_login_at: Optional[datetime] = None
    recent_logins: list[datetime] = []
    active_postings: list[PostingSummary] = []


class PaginatedCamerasOut(BaseModel):
    cameras: list[CameraOut]
    next_cursor: Optional[int] = None


class CameraSummaryOut(BaseModel):
    total: int
    online: int
    degraded: int
    offline: int
    real_stream_count: int
    synthetic_count: int
    edge_node_count: int


class DistrictCount(BaseModel):
    district: str
    count: int


class DistrictSummaryOut(BaseModel):
    districts: list[DistrictCount]


class SyntheticDetectionEventIn(BaseModel):
    event_id: str
    camera_id: int
    edge_node_id: Optional[int] = None
    payload: Optional[dict] = None


class SyntheticDetectionEventAccepted(BaseModel):
    event_id: str
    status: str = "accepted"


class ArchiveResult(BaseModel):
    archived: int


class TestStreamIn(BaseModel):
    """Same two ways of pointing at a stream as CameraCreate/CameraUpdate --
    checked here before a camera exists at all, so the Add Camera modal can
    tell an officer "can't reach this feed" before they save, not after."""
    stream_id: Optional[str] = None
    hls_url: Optional[str] = None


class TestStreamOut(BaseModel):
    reachable: bool


class RecordingHealthEventIn(BaseModel):
    event_id: str
    # The recording service's own camera path (matches cameras.stream_id) --
    # not the registry's numeric camera id, since the recorder only knows
    # the path it's ingesting from.
    path: str
    status: str
    message: Optional[str] = None
    occurred_at: Optional[str] = None
    payload: Optional[dict] = None


class RecordingHealthEventAccepted(BaseModel):
    event_id: str
    status: str = "accepted"


class CoverageTargetCreate(BaseModel):
    name: str
    lat: float
    long: float
    district: str
    priority: str = "medium"


class CoverageTargetUpdate(BaseModel):
    name: Optional[str] = None
    lat: Optional[float] = None
    long: Optional[float] = None
    district: Optional[str] = None
    priority: Optional[str] = None


class CoverageTargetOut(CoverageTargetCreate):
    id: int


class PoliceStationCreate(BaseModel):
    name: str
    lat: float
    long: float
    district: str
    contact: Optional[str] = None


class PoliceStationUpdate(BaseModel):
    name: Optional[str] = None
    lat: Optional[float] = None
    long: Optional[float] = None
    district: Optional[str] = None
    contact: Optional[str] = None


class PoliceStationOut(PoliceStationCreate):
    id: int


class AreaCreate(BaseModel):
    name: str
    village_id: int


class AreaUpdate(BaseModel):
    name: Optional[str] = None
    village_id: Optional[int] = None


class AreaOut(AreaCreate):
    id: int
    created_at: datetime
    # Denormalized via areas_service's join -- where this area actually is,
    # without a separate villages/talukas/districts round trip per area.
    village: str
    taluka: str
    district: str
    district_id: int


class DistrictOut(BaseModel):
    id: int
    name: str
    lgd_code: Optional[str] = None


class TalukaOut(BaseModel):
    id: int
    name: str
    district_id: int
    no_lgd_data: bool


class VillageOut(BaseModel):
    id: int
    name: str
    taluka_id: int
    is_urban: bool


class UncoveredZone(BaseModel):
    target_id: int
    name: str
    district: str
    priority: str
    nearest_camera_id: Optional[int] = None
    distance_meters: Optional[float] = None


class AgeingCamera(BaseModel):
    camera_id: int
    name: str
    district: str
    age_days: int
    degraded_transition_count_90d: int
    risk_level: str


class PlacementSuggestion(BaseModel):
    """One recommended new-camera site, from gap_analysis_service's greedy
    set-cover placement algorithm -- see that module's docstring for why
    greedy (not ILP) is the right tradeoff here."""
    suggested_at_target_id: int
    suggested_at_name: str
    district: str
    lat: float
    long: float
    covers_target_ids: list[int]
    priority_weighted_score: float


class GapAnalysisReport(BaseModel):
    uncovered_zones: list[UncoveredZone]
    ageing_infrastructure: list[AgeingCamera]
    placement_suggestions: list[PlacementSuggestion] = []


class DiscoveredCamera(BaseModel):
    """One ONVIF device found by a WS-Discovery network scan -- see
    onvif_discovery_service.py. Deliberately shaped close to CameraCreate's
    fields so a discovered device can be handed straight to POST
    /cameras/bulk once an officer fills in dept/lat/long (discovery finds
    *that a device exists*, not what department owns it or where it sits on
    a map -- neither is knowable from the network probe alone)."""
    ip_address: str
    onvif_service_url: str
    device_uuid: Optional[str] = None
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    firmware_version: Optional[str] = None
    stream_uri: Optional[str] = None
    ptz_capable: Optional[bool] = None
    reachable_detail: Optional[str] = None


class DiscoveryScanResult(BaseModel):
    devices: list[DiscoveredCamera]
    scan_duration_seconds: float
    subnet_scanned: Optional[str] = None


class ChainVerifyResult(BaseModel):
    valid: bool
    chained_rows: int
    broken_at_id: Optional[int] = None
    reason: Optional[str] = None


class AuditLogOut(BaseModel):
    id: int
    badge_number: Optional[str] = None
    action: str
    resource_type: str
    resource_id: Optional[int] = None
    reason_code: Optional[str] = None
    timestamp: datetime
    category: str
    actor_name: Optional[str] = None
    camera_name: Optional[str] = None
    camera_district: Optional[str] = None
    camera_area: Optional[str] = None


class AuditLogsPage(BaseModel):
    logs: list[AuditLogOut]
    next_cursor: Optional[int] = None

