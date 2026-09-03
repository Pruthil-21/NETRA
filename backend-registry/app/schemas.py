"""
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
    stream_id: Optional[str] = None
    hls_url: Optional[str] = None
    is_synthetic: bool = False
    edge_node_id: Optional[str] = None
    scale_run_id: Optional[str] = None


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
    is_synthetic: Optional[bool] = None
    edge_node_id: Optional[str] = None
    scale_run_id: Optional[str] = None


class CameraOut(BaseModel):
    id: int
    name: str
    dept: str
    lat: float
    long: float
    camera_type: str
    ownership: str
    connectivity_status: str
    storage_type: str
    retention_days: int
    health_status: str
    rtsp_url: Optional[str]
    stream_id: Optional[str]
    hls_url: Optional[str]
    created_at: str
    is_synthetic: bool
    edge_node_id: Optional[str]
    scale_run_id: Optional[str]


class CameraBulkResult(BaseModel):
    camera_id: Optional[int] = None
    success: bool
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
    cameras_by_health_status: dict[str, int]
    # alerts_last_24h and detections_last_24h are only populated in the
    # environment — see reports_service._count_last_24h.
    alerts_last_24h: Optional[int] = None
    detections_last_24h: Optional[int] = None
    blacklist_entries_last_24h: Optional[int] = None
    avg_alert_response_seconds: Optional[float] = None
