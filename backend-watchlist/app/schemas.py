"""Pydantic request/response models for the watchlist and alerts API.

Field names match /contract/API_CONTRACT.md exactly — this is what keeps
frontend-dashboard's mock data and this real API interchangeable.
"""
import uuid
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
    omit all three and behave exactly as before.

    event_id is a client-supplied idempotency key for live detections: a
    caller that retries a POST (e.g. after a timeout, not knowing whether
    the first attempt landed) sends the same event_id both times, and the
    server returns the original detection+alert instead of creating a
    second one. Independent of scenario_run_id's replay-dedup mechanism;
    omit it and behave exactly as before (no dedup)."""
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
    event_id: Optional[uuid.UUID] = None

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
    event_id: Optional[uuid.UUID] = None


class DensityPoint(BaseModel):
    """One camera's detection count for the Map page's density layer --
    see detections_service.camera_density_counts."""
    camera_id: int
    count: int


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
    # Combined VAHAN (ownership) + eGujCop (crime/FIR) lookup -- computed at
    # read time by alerts_service, not stored on the alerts row (see
    # govt_lookup_service.py). Shape: {"vahan": {...}, "egujcop": {...}},
    # each with its own `status` field -- "not_configured" until real access
    # exists, so this is always present but not yet populated with real data.
    owner_details: Optional[dict] = None
    # Closest backend-registry police_stations row to the alert's camera, by
    # geographic distance -- computed at read time by alerts_service (see
    # _with_nearest_station). None when no police_stations rows exist yet.
    nearest_station: Optional[dict] = None


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
    # A registered camera's stream_id (backend-registry cameras.stream_id)
    # is TEXT, not guaranteed numeric -- only the hardcoded vehicle-trace-demo
    # cameras happen to use small ints for it.
    stream_id: Optional[str] = None
    detected_at: datetime
    confidence: Optional[float] = None
    # Inferred direction/speed of the leg from the previous sighting to this
    # one (None for the first sighting, or when either point lacks
    # coordinates) -- see services/geo.py's leg_bearing_and_speed.
    bearing_deg: Optional[float] = None
    speed_kmh: Optional[float] = None
    # "improbable_speed" / "extended_gap" (see geo.classify_leg_anomaly) when
    # this leg trips a heuristic worth an investigator's attention, None
    # otherwise. A heuristic flag, not a finding -- never surfaced as proof
    # of anything on its own.
    anomaly: Optional[str] = None


class PredictedNextCamera(BaseModel):
    """One candidate in "where is this plate likely to be seen next" -- see
    detections_service.predict_next_camera. Mined from every plate's
    historical camera-to-camera transitions, not this one plate's own
    (too sparse to predict from alone)."""
    camera_id: int
    camera_name: Optional[str] = None
    confidence: float


class VehicleTraceResponse(BaseModel):
    """Response for GET /vehicle-traces/{plate_number} — sightings ordered
    oldest-first for a route/timeline view."""
    scenario_run_id: Optional[str] = None
    plate: str
    label: str = "Inferred route from simulated camera sightings"
    sightings: list[VehicleTraceSighting]
    # Predicted next camera(s) from the *last* sighting's camera, based on
    # network-wide historical transitions -- empty when there are no
    # sightings yet, or no observed outbound transitions from that camera.
    predicted_next: list[PredictedNextCamera] = []


class PredictNextCameraResponse(BaseModel):
    """Response for GET /vehicle-traces/predict-next/{camera_id} -- the
    standalone form of the same prediction, usable from a camera_id alone
    (e.g. a normal fuzzy-matched plate search, which never goes through
    GET /vehicle-traces/{plate} at all -- see detectionService.ts)."""
    camera_id: int
    candidates: list[PredictedNextCamera]


DetectionResult.model_rebuild()