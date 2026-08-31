"""Pydantic request/response models for the watchlist and alerts API.

Field names match /contract/API_CONTRACT.md exactly — this is what keeps
frontend-dashboard's mock data and this real API interchangeable.
"""
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel


class WatchlistCreate(BaseModel):
    plate_number: str
    reason: str
    dept_flagged: str
    priority: Literal["low", "medium", "high"] = "medium"


class WatchlistOut(WatchlistCreate):
    id: int
    date_added: datetime


class DetectionIn(BaseModel):
    """Payload sent by ml-anpr for every confirmed plate read, regardless of
    watchlist status. confidence is the OCR confidence score; optional since
    not every caller may have one to send."""
    camera_id: int
    plate_number: str
    confidence: Optional[float] = None


class DetectionOut(BaseModel):
    id: int
    plate_number: str
    camera_id: int
    detected_at: datetime
    confidence: Optional[float] = None


class DetectionResult(BaseModel):
    """Response for POST /detections — the detection is always recorded;
    alert is populated only when the plate matched the watchlist."""
    detection: DetectionOut
    alert: Optional["AlertOut"] = None


class AlertOut(BaseModel):
    id: int
    camera_id: int
    plate_number: str
    watchlist_id: int
    detection_id: Optional[int] = None
    matched_at: datetime
    status: str


class AlertStatusUpdate(BaseModel):
    status: Literal["ACKNOWLEDGED", "DISMISSED", "ESCALATED"]


DetectionResult.model_rebuild()