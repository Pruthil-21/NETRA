"""Pydantic request/response models for the cameras API.

Field names match /contract/API_CONTRACT.md exactly.
"""
from typing import Optional

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
