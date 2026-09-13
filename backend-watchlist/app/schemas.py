"""Pydantic request/response models for the watchlist and alerts API.

Field names match /contract/API_CONTRACT.md exactly — this is what keeps
frontend-dashboard's mock data and this real API interchangeable.
"""
import uuid
from datetime import datetime
from typing import Literal, Optional

from pydantic import AliasChoices, BaseModel, Field, field_validator, model_validator


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


class CorridorFlow(BaseModel):
    """One camera-to-camera transition pair for the Map page's Flow layer --
    see detections_service.camera_flow_pairs. avg_speed_kmh is the average
    inferred travel speed across every plate that made this transition in
    the window, not any single vehicle's speed."""
    from_camera_id: int
    to_camera_id: int
    transitions: int
    avg_speed_kmh: Optional[float] = None
    # Road-following [[lat, lon], ...] path between the two cameras (see
    # route_geometry_service.get_or_fetch_route) -- None when OSRM couldn't
    # resolve one, which the frontend falls back to a straight line for.
    route: Optional[list[list[float]]] = None


class TrendBucket(BaseModel):
    """One time bucket in a historical trends chart -- see
    detections_service.camera_density_trend/camera_flow_trend. bucket_start
    is an IST calendar boundary (midnight or the top of the hour), matching
    the hour-of-day playback convention the live density/flow endpoints
    already use."""
    bucket_start: datetime
    count: int


class DensityTrendResponse(BaseModel):
    trend: list[TrendBucket]
    top_cameras: list[DensityPoint]


class FlowTrendResponse(BaseModel):
    trend: list[TrendBucket]
    top_corridors: list[CorridorFlow]


class TrafficAlertOut(BaseModel):
    """A congestion or camera-health breach -- see traffic_alerts_service and
    schema.sql's traffic_alerts table. Exactly one of camera_id (a density or
    camera_offline breach) or from_camera_id/to_camera_id (a flow/corridor
    breach) is set, matching alert_type."""
    id: int
    alert_type: Literal["density", "flow", "camera_offline"]
    camera_id: Optional[int] = None
    from_camera_id: Optional[int] = None
    to_camera_id: Optional[int] = None
    metric_value: float
    threshold_value: float
    district: Optional[str] = None
    status: Literal["NEW", "ACKNOWLEDGED", "DISMISSED"]
    triggered_at: datetime
    acknowledged_by: Optional[str] = None
    acknowledged_at: Optional[datetime] = None


class TrafficAlertStatusUpdate(BaseModel):
    status: Literal["ACKNOWLEDGED", "DISMISSED"]


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

    @model_validator(mode="after")
    def _require_reason_on_dismiss(self):
        # A dismissed watchlist hit with no recorded reason is an
        # accountability gap -- Acknowledge/Escalate leave the alert open to
        # further action so they don't need one, but Dismiss is final.
        if self.status == "DISMISSED" and not (self.reason_code or "").strip():
            raise ValueError("reason_code is required when dismissing an alert")
        return self


class AlertHistoryEntry(BaseModel):
    action: str
    badge_number: Optional[str] = None
    timestamp: datetime
    reason_code: Optional[str] = None


class ArchiveClipJobIn(BaseModel):
    """POST /anpr-jobs/archive-clip body -- district is derived server-side
    from source_camera_id's own dept, not accepted from the client (see
    routers/anpr_jobs.py)."""
    source_camera_id: int
    clip_start: datetime
    clip_end: datetime

    @model_validator(mode="after")
    def _clip_end_after_start(self):
        if self.clip_end <= self.clip_start:
            raise ValueError("clip_end must be after clip_start")
        return self


class AnprJobResultOut(BaseModel):
    id: int
    detection_id: Optional[int] = None
    plate_number: str
    confidence: Optional[float] = None
    # The real in-footage moment for a video/clip job (null for a photo --
    # there's no timeline to place it on). See anpr_job_results' own
    # schema.sql comment.
    detected_at: Optional[datetime] = None
    box_area: Optional[float] = None


class AnprJobOut(BaseModel):
    id: int
    input_type: Literal["upload_video", "upload_image", "archive_clip"]
    status: Literal["pending", "processing", "completed", "failed"]
    submitted_by: str
    district: str
    original_filename: Optional[str] = None
    file_size_bytes: Optional[int] = None
    file_sha256: Optional[str] = None
    source_camera_id: Optional[int] = None
    clip_start: Optional[datetime] = None
    clip_end: Optional[datetime] = None
    # upload_video only, officer-supplied and optional -- see anpr_jobs
    # schema.sql. Doubles as the "recording_start_time" anchor dispatch
    # sends ml-anpr for computing each result's real detected_at.
    recorded_at: Optional[datetime] = None
    detection_id: Optional[int] = None
    plate_number: Optional[str] = None
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    # Every plate found, ordered nearest-to-farthest for a photo (by
    # box_area) or chronologically for a video/clip (by detected_at) -- see
    # anpr_jobs_service.list_job_results. Empty for a job still pending/
    # processing, or one that completed with no plate found at all.
    results: list[AnprJobResultOut] = []


class AnprJobResultIn(BaseModel):
    """One plate within ml-anpr's completion callback -- see AnprJobCallback.
    detected_at is REQUIRED for a video/clip job (ml-anpr must compute the
    real in-footage instant from clip_start + the frame offset, never
    "now()" -- the plate may have been seen minutes into a clip processed
    well after the fact) and should be omitted for a photo job, which has
    no timeline to place it on."""
    detection_id: int
    plate_number: str
    confidence: Optional[float] = None
    detected_at: Optional[datetime] = None
    box_area: Optional[float] = None


class AnprJobCallback(BaseModel):
    """PATCH /anpr-jobs/{id} body -- ml-anpr's completion callback, internal-
    key gated same as POST /detections. Each result's plate_number/
    detection_id comes straight from ml-anpr (it already knows what it
    read and what POST /detections handed back) rather than being looked up
    server-side. `results` may be an empty list on a genuine "completed, no
    plate found" outcome -- that's a valid terminal state, not an error."""
    status: Literal["completed", "failed"]
    results: list[AnprJobResultIn] = []
    error_message: Optional[str] = None


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