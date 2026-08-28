"""Pydantic request/response models for the cameras API.

Field names match /contract/API_CONTRACT.md exactly.
"""
from typing import Literal, Optional

from pydantic import BaseModel


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


class CameraOut(CameraCreate):
    id: int


class CameraBulkResult(BaseModel):
    """One row's outcome from POST /cameras/bulk — a bad row never fails the
    whole batch, so the caller needs a per-row success/failure verdict."""
    index: int
    status: Literal["created", "error"]
    camera: Optional[CameraOut] = None
    reason: Optional[str] = None


class ReportSummary(BaseModel):
    total_cameras: int
    cameras_by_department: dict[str, int]
    cameras_by_connectivity_status: dict[str, int]
    cameras_by_health_status: dict[str, int]
    # None when backend-watchlist's schema hasn't been applied yet in this
    # environment — see reports_service._count_last_24h.
    alerts_last_24h: Optional[int] = None
    detections_last_24h: Optional[int] = None
