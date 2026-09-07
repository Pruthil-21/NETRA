"""The detection event schema (P3 handoff item 5: event_id, camera_id,
timestamp, model version, confidence, and detection type in every
event).

`event_id` is now a documented, real idempotency key: backend-watchlist's
POST /detections accepts it as an optional client-supplied UUID and dedups
on it server-side (see contract/API_CONTRACT.md, backend-watchlist commit
2cb1757 on origin/feature/backend-watchlist -- not yet merged to main).
This module generates one automatically per event, so retries get real
duplicate-safety once pointed at a backend with that contract -- see
event_sender.py's module docstring for the retry-path details.

`timestamp`/`model_version`/`detection_type` remain extra fields beyond
what's documented (most REST frameworks silently ignore unrecognized
fields rather than reject the request), sent for forward-compatibility
and our own audit trail -- don't assume the backend stores or uses those
three yet.
"""
import time
import uuid
from dataclasses import dataclass, field

# Bumped whenever the detection pipeline's model/logic changes in a way
# that could shift accuracy -- lets anyone looking at stored detections
# later tell which model version actually produced a given read.
# Mirrors this branch's real state: yolov8n + PaddleOCR + the VLM
# fallback added this session.
MODEL_VERSION = "anpr-pipeline-2026.09-vlm-fallback"


@dataclass
class DetectionEvent:
    camera_id: str
    plate_number: str
    confidence: float
    detection_type: str  # the tracker's "note" field, e.g. "ok - pattern match"
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: float = field(default_factory=time.time)  # unix epoch seconds
    model_version: str = MODEL_VERSION

    def to_backend_payload(self, numeric_camera_id):
        """The JSON body actually POSTed to backend-watchlist. Takes the
        already-resolved numeric camera_id (via CAMERA_ID_MAP) as a
        parameter rather than storing it on the event itself -- this
        object's own camera_id is the pipeline-side string
        (e.g. "direct-cam06"), matching every other camera_id_str used
        throughout anpr/streaming.py and anpr/watchlist_client.py, not
        the backend's numeric id.

        Deliberately does NOT send `detected_at`: the real handoff
        (2026-09-07) documents it as ISO 8601, optional, "omit it and we
        timestamp it server-side at receipt time -- only send this if
        you need to backfill a specific capture time." This event's own
        `timestamp` is a raw Unix-epoch float (see the field above), not
        ISO 8601 -- sending it as `detected_at` would have been a real
        format mismatch, not just an unnecessary field, for every live
        detection this pipeline produces (none of them are backfills).
        Kept on the Python object for our own logging/audit use; just
        not put on the wire.
        """
        return {
            "camera_id": numeric_camera_id,
            "plate_number": self.plate_number,
            "confidence": self.confidence,
            # Extra fields, not in the documented contract -- see module
            # docstring. Included for forward-compatibility and our own
            # audit trail even if the backend ignores them today.
            "event_id": self.event_id,
            "model_version": self.model_version,
            "detection_type": self.detection_type,
        }
