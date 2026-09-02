"""The detection event schema (P3 handoff item 5: event_id, camera_id,
timestamp, model version, confidence, and detection type in every
event).

Real backend-watchlist's POST /detections only documents/guarantees use
of {camera_id, plate_number, confidence} (see contract/API_CONTRACT.md)
-- event_id/timestamp/model_version/detection_type aren't part of its
documented contract today. Sent anyway as extra JSON fields (most REST
frameworks silently ignore unrecognized fields rather than reject the
request) so the richer schema is already in place and forward-compatible
if the contract gets extended later, without a client change -- but
don't assume the backend actually stores or uses them yet; that's an
open question for P6, not something this module can confirm on its own.
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
        """
        return {
            "camera_id": numeric_camera_id,
            "plate_number": self.plate_number,
            "confidence": self.confidence,
            # Extra fields, not in the documented contract -- see module
            # docstring. Included for forward-compatibility and our own
            # audit trail even if the backend ignores them today.
            "event_id": self.event_id,
            "detected_at": self.timestamp,
            "model_version": self.model_version,
            "detection_type": self.detection_type,
        }
