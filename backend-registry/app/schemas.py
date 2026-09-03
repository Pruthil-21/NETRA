"""Pydantic request/response models for the cameras API.

Field names match /contract/API_CONTRACT.md exactly.
"""
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


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


class LoginResponse(BaseModel):
    token: str


class MeResponse(BaseModel):
    badge_number: str
    name: str
    role: str
    scope_type: str
    scope_value: Optional[str] = None
    permissions: list[str]


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


class RolePermissionsOut(BaseModel):
    name: str
    display_name: str
    hierarchy_level: Optional[int] = None
    permissions: list[str]


class RolePermissionsUpdate(BaseModel):
    permissions: list[str]
    reason_code: Optional[str] = None


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


class UncoveredZone(BaseModel):
    target_id: int
    name: str
    district: str
    nearest_camera_id: Optional[int] = None
    distance_meters: Optional[float] = None


class AgeingCamera(BaseModel):
    camera_id: int
    name: str
    district: str
    age_days: int
    degraded_transition_count_90d: int


class GapAnalysisReport(BaseModel):
    uncovered_zones: list[UncoveredZone]
    ageing_infrastructure: list[AgeingCamera]
