"""Pydantic request/response models for the watchlist and alerts API.

Field names match /contract/API_CONTRACT.md exactly — this is what keeps
frontend-dashboard's mock data and this real API interchangeable.
"""
from datetime import datetime
from typing import Literal, Optional

from pydantic import AliasChoices, BaseModel, Field, field_validator


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
    # "plate" is accepted as an alias of "plate_number" — some scripted
    # callers (e.g. the vehicle-trace demo sender) send the shorter name.
    # plate_number stays the canonical field everywhere else in this API
    # (watchlist, alerts, GET /detections), including in every response.
    plate_number: str = Field(validation_alias=AliasChoices("plate_number", "plate"))
    confidence: Optional[float] = None
    detected_at: Optional[datetime] = None
    scenario_run_id: Optional[str] = None
    source: Optional[str] = None

    model_config = {"populate_by_name": True}

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
    reason_code: Optional[str] = None


class VehicleTraceSighting(BaseModel):
    """One entry in VehicleTraceResponse.sightings — a detection enriched
    with the camera metadata frontend-map needs to place it on the route
    (camera_name/latitude/longitude/stream_id), so the caller never has to
    cross-reference backend-registry itself for this view. plate_number and
    scenario_run_id aren't repeated per-sighting since they're already on
    the parent response."""
    camera_id: int
    camera_name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    stream_id: Optional[int] = None
    detected_at: datetime
    confidence: Optional[float] = None


class VehicleTraceResponse(BaseModel):
    """Response for GET /vehicle-traces/{plate_number} — sightings ordered
    oldest-first for a route/timeline view."""
    scenario_run_id: Optional[str] = None
    plate: str
    label: str = "Inferred route from simulated camera sightings"
    sightings: list[VehicleTraceSighting]


DetectionResult.model_rebuild()