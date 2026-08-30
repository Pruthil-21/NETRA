"""Pydantic request/response models for the watchlist and alerts API.

Field names match /contract/API_CONTRACT.md exactly — this is what keeps
frontend-dashboard's mock data and this real API interchangeable.
"""
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, field_validator


def normalize_plate(value: str) -> str:
    """`GX15 OGJ` and `GX15OGJ` must match — strip all whitespace and
    upper-case so storage, dedup and lookups all key off one canonical form."""
    return "".join(value.split()).upper()


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
    not every caller may have one to send.

    detected_at / scenario_run_id / source are optional additions for
    scripted/replayed sources (e.g. the vehicle-trace demo clip): a replay
    supplies the sighting's own timestamp and tags itself with a run id so
    repeats from the looping clip can be suppressed (see
    services.detections_service.record_detection). Live ml-anpr detections
    omit all three and behave exactly as before."""
    camera_id: int
    plate_number: str
    confidence: Optional[float] = None
    detected_at: Optional[datetime] = None
    scenario_run_id: Optional[str] = None
    source: Optional[str] = None

    @field_validator("plate_number")
    @classmethod
    def _normalize_plate_number(cls, value: str) -> str:
        return normalize_plate(value)


class DetectionOut(BaseModel):
    id: int
    plate_number: str
    camera_id: int
    detected_at: datetime
    confidence: Optional[float] = None
    scenario_run_id: Optional[str] = None
    source: Optional[str] = None


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


class VehicleTraceSighting(BaseModel):
    """One row of GET /vehicle-traces/{plate_number} — a detection enriched
    with the camera metadata frontend-map needs to place it on the route
    (camera_name/latitude/longitude/stream_id), so the caller never has to
    cross-reference backend-registry itself for this view."""
    id: int
    plate_number: str
    camera_id: int
    camera_name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    stream_id: Optional[str] = None
    detected_at: datetime
    confidence: Optional[float] = None
    scenario_run_id: Optional[str] = None
    source: Optional[str] = None


DetectionResult.model_rebuild()