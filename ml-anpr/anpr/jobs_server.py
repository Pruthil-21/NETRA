"""HTTP endpoint for Pruthil's Manual Plate Lookup feature (handoff,
2026-09-12): accepts a job (an uploaded video/image, or a short-lived
archive-clip URL), runs it through the existing detection pipeline,
POSTs the result to backend-watchlist exactly like every other
detection, then PATCHes the job's callback_url with the outcome so
their UI can deep-link straight to it.

Uses stdlib http.server only, matching label_crops_web.py's existing
pattern in this repo rather than adding a new web framework dependency
for one route.
"""
import json
import os
import tempfile
import threading
import traceback
import uuid
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import requests

import anpr.detection as detection
from .config import DETECTION_API_URL, INTERNAL_KEY
from .detection import detect_plate_from_frame
from .pipeline.events import DetectionEvent
from .plate_format import INDIAN_PLATE_PATTERN
from .tracking import VehicleTracker

# The plate-presence gate is unsafe to bypass unconditionally here after
# all -- measured directly: with it off, this endpoint took 223s of real
# compute for one 16-second clip, dominated by exactly the OCR passes
# the gate exists to skip. But it's also unsafe to leave ON
# unconditionally: confirmed directly on a real two-vehicle test photo,
# the gate marked a car "No plate (fast skip)" even though its plate was
# clearly visible and OCR read it correctly once actually given the
# chance -- catastrophic for a single photo, which gets exactly one look
# at each vehicle.
#
# Video/archive_clip don't have that excuse: the same vehicle gets many
# sampled frames, so one frame's gate false-negative just means slightly
# fewer of that vehicle's reads feed the reconstruction, not a missed
# plate outright -- this project's own real A/B test on live video found
# the gate's actual cost there was indistinguishable from ordinary
# run-to-run OCR noise (confirmed by testing a 10x stricter threshold:
# identical result), while its speedup (30.6%) was real. So: gate ON for
# video/archive_clip, OFF for upload_image -- decided per job via
# thread-local state (not a shared module attribute) since multiple jobs
# can run concurrently on separate threads and must not stomp on each
# other's setting.
_real_probably_has_no_plate = detection._probably_has_no_plate
_gate_state = threading.local()


def _gated_probably_has_no_plate(crop):
    if getattr(_gate_state, "bypass", False):
        return False
    return _real_probably_has_no_plate(crop)


detection._probably_has_no_plate = _gated_probably_has_no_plate

# yolov8n (the shared production model) missed a real motorcycle
# entirely across 40+ consecutive frames of a real test clip -- verified
# directly: yolov8s (already sitting in the repo, unused) picked up the
# same motorcycle at the same frames yolov8n produced zero boxes for any
# class, and read every car in the clip at meaningfully higher
# confidence too. Not swapped in globally -- that's a live-pipeline
# speed/behavior change that needs its own real A/B test, out of scope
# here. Does cost real time (part of why the gate above matters more
# now, not less) -- accepted anyway for job processing specifically,
# since a wrong "no vehicle here" from the smaller model is a result the
# officer can never get back, unlike a few extra seconds. Scoped to this
# process only, via the same live-module-attribute swap used for the
# gate above.
try:
    from ultralytics import YOLO as _YOLO
    detection.yolo_model = _YOLO("yolov8s.pt").to(detection.device)
except Exception as e:  # noqa: BLE001
    print(f"[WARN] Could not load yolov8s.pt for job processing, falling back to the shared model ({e})")

REQUEST_TIMEOUT_SEC = 10

# Bound #1: concurrent manual-lookup jobs. Each one loads real frames
# through YOLO+OCR on this same process's GPU/CPU -- unbounded concurrent
# jobs is the same real failure mode already measured on the live
# multi-camera pipeline (queue saturation, throughput collapse) applied
# to this endpoint instead. A semaphore acquired inside the worker
# thread (not before it starts) queues excess jobs rather than dropping
# them: do_POST still returns 202 immediately either way, a job just
# waits its turn to actually start once past the limit.
MAX_CONCURRENT_JOBS = 3
_job_slots = threading.Semaphore(MAX_CONCURRENT_JOBS)

# Bound #2: download size. Nothing capped how large a file_url/clip_url
# response could be -- a wrong or malicious URL could exhaust this
# machine's disk one job at a time. Checked against both a declared
# Content-Length (fails fast) and actual bytes received (a header can
# lie or be absent), whichever trips first.
MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024  # 500 MB

# Idempotent event_id: derived from (job_id, plate_number) instead of a
# fresh random UUID per POST, so re-processing the SAME job (a retry
# after a timeout, a duplicate dispatch) reproduces the SAME event_id
# for the SAME plate every time. backend-watchlist dedups on event_id
# server-side (see events.py's own docstring) -- a stable id is what
# actually makes that dedup protect us here; a random one per attempt
# would create a genuine duplicate detection row on every retry instead
# of a safe no-op resend.
_JOB_EVENT_NAMESPACE = uuid.UUID("6f6b1f4a-3f0d-4b1a-9c1e-9a7b2f8e5c3d")


def _job_event_id(job_id, plate_number):
    return str(uuid.uuid5(_JOB_EVENT_NAMESPACE, f"{job_id}:{plate_number}"))


def _box_area_fraction(box, frame_shape):
    """Normalized 0-1 fraction of the frame the vehicle box covers --
    what Pruthil's callback contract calls box_area, used on his side to
    rank multiple plates in one result nearest-to-farthest."""
    if box is None:
        return None
    x1, y1, x2, y2 = box
    frame_h, frame_w = frame_shape[:2]
    if frame_h <= 0 or frame_w <= 0:
        return None
    return round((max(0, x2 - x1) * max(0, y2 - y1)) / (frame_w * frame_h), 4)


def _parse_iso8601(ts):
    """datetime.fromisoformat() on Python 3.9 (this venv) doesn't accept
    a trailing 'Z' -- recording_start_time arrives in that form (e.g.
    Pruthil's own example detected_at, "2026-09-12T10:02:15Z")."""
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _format_iso8601(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _run_video(path, process_every_n_frames=5, window_size=50):
    """Same detect_plate_from_frame + VehicleTracker loop as
    streaming.process_video_file(), but returns confirmed plates
    instead of printing/sending them, and decides each vehicle's final
    plate only after seeing its WHOLE trajectory, not the moment its
    first 2 reads happen to agree.

    Why: PlateConfirmationTracker (tracking.py) fires the instant a
    cluster crosses confirm_threshold (2 by default) -- exactly right
    for a live stream, which has to decide before a vehicle leaves frame
    for good. But confirmed here is FINAL: once a cluster's
    representative is added to self.confirmed, any later cluster
    similar to it is suppressed, even if the vehicle has since driven
    closer and started producing a clean, correct read. Verified
    directly on a real test clip: a distant, blurry two-read agreement
    ("GLLT7D") locked in before the same vehicle's true plate
    ("GJ27DB0906") ever got a chance, even though that plate went on to
    read identically, at ~1.0 confidence, across 30+ later frames.

    A manual-lookup job doesn't have the live stream's excuse -- the
    whole clip is already downloaded before this function is even
    called, so there's no reason to decide early. Fix: set
    confirm_threshold above window_size so the tracker's own live-fire
    path can mathematically never trigger (len(cluster["readings"]) is
    capped at window_size), run the identical detect_plate_from_frame +
    tracker.update() loop for its box-association/clustering machinery,
    but hold a reference to every track's dict as it appears (VehicleTracker
    prunes a track from its own list after MAX_MISSED_FRAMES, which
    would otherwise lose its accumulated PlateConfirmationTracker state
    the moment a vehicle leaves frame -- these references keep it alive).
    Once the whole video's been read, reconstruct each track's dominant
    cluster (the one with the most accumulated readings -- a real,
    repeating plate reliably outgrows a one-off garbage misread) exactly
    the way PlateConfirmationTracker.add() would have, just once, with
    the benefit of every reading the vehicle ever produced instead of
    just the first two.

    Each returned dict also carries box_area (from the track's last-seen
    box) and elapsed_video_seconds (last-seen frame / fps -- time within
    the clip itself, not a wall-clock value). elapsed_video_seconds is
    NOT yet turned into an absolute detected_at: doing that needs a
    real-world anchor point (when the recording/clip actually started)
    that nothing in the job payload currently provides -- see
    jobs_server.py module docstring. Sending time.time() instead would
    be exactly the "now(), not the real capture moment" mistake
    Pruthil's handoff explicitly warned against, so this is deliberately
    left for the caller to fill in once that's resolved, not guessed
    here.
    """
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return []
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    tracker = VehicleTracker(window_size=window_size, confirm_threshold=window_size + 1)
    frame_count = 0
    seen_track_ids = set()
    all_tracks = []
    frame_shape = None
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frame_count += 1
        if frame_count % process_every_n_frames != 0:
            continue
        frame_shape = frame.shape
        results = detect_plate_from_frame(frame, frame, tracker=tracker)
        tracker.update(results, raw_frame=frame)
        for t in tracker.tracks:
            tid = id(t)
            if tid not in seen_track_ids:
                seen_track_ids.add(tid)
                all_tracks.append(t)
            t["_last_seen_frame"] = frame_count
    cap.release()
    if frame_shape is None:
        return []

    confirmed_results = []
    seen_plates = set()
    for t in all_tracks:
        pct = t["tracker"]
        if not pct.clusters:
            continue
        best_cluster = max(pct.clusters, key=lambda c: len(c["readings"]))
        representative = pct._reconstruct(best_cluster["readings"])
        best_conf = max(c for _, c, _ in best_cluster["readings"])
        note = "ok - pattern match" if INDIAN_PLATE_PATTERN.match(representative) \
            else "ok - fallback, unverified pattern"
        min_conf = 0.25 if note == "ok - pattern match" else 0.4
        if best_conf < min_conf or representative in seen_plates:
            continue
        seen_plates.add(representative)
        confirmed_results.append({
            "plate_number": representative,
            "confidence": float(round(best_conf, 2)),
            "note": note,
            "box_area": _box_area_fraction(t.get("box"), frame_shape),
            "elapsed_video_seconds": round(t.get("_last_seen_frame", frame_count) / fps, 2),
        })
    return confirmed_results


def _download_to_temp(url, default_suffix, headers=None):
    """Both file_url (upload_video/upload_image -- a job_id/file path on
    their backend, needs our internal key to fetch) and clip_url
    (archive_clip -- a plain playback URL, no auth) point at bytes that
    only exist on their end, never a local path on this machine (the
    original file_path design assumed a shared filesystem, which broke
    the first real cross-machine test). Downloaded to a temp file either
    way so both go through the exact same cv2 path as a real local
    upload would, rather than depending on cv2/FFmpeg's own (less
    reliable) direct-HTTP-read support."""
    resp = requests.get(url, headers=headers, timeout=30, stream=True)
    resp.raise_for_status()
    declared_length = resp.headers.get("Content-Length")
    if declared_length is not None and int(declared_length) > MAX_DOWNLOAD_BYTES:
        raise ValueError(f"Declared size {int(declared_length)} bytes exceeds "
                          f"the {MAX_DOWNLOAD_BYTES} byte limit")
    suffix = os.path.splitext(url.split("?")[0])[1] or default_suffix
    fd, path = tempfile.mkstemp(suffix=suffix)
    written = 0
    try:
        with os.fdopen(fd, "wb") as f:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                written += len(chunk)
                if written > MAX_DOWNLOAD_BYTES:
                    raise ValueError(f"Download exceeded the {MAX_DOWNLOAD_BYTES} byte "
                                      f"limit (Content-Length was absent or wrong)")
                f.write(chunk)
    except Exception:
        if os.path.exists(path):
            os.remove(path)
        raise
    return path


def _patch_callback(callback_url, payload):
    try:
        requests.patch(callback_url, json=payload, headers={"X-Internal-Key": INTERNAL_KEY},
                        timeout=REQUEST_TIMEOUT_SEC)
    except requests.exceptions.RequestException as e:
        print(f"[WARN] Could not reach callback_url {callback_url}: {e}")


def _process_job(job):
    """Runs off the request thread (do_POST already returned 202) --
    a job can take real time (a full video, a download), and the
    contract here is a later PATCH callback, not a synchronous response
    body. Blocks on _job_slots first (see MAX_CONCURRENT_JOBS) -- a job
    beyond the concurrency limit just waits its turn here rather than
    running unbounded alongside everything else already in flight."""
    with _job_slots:
        _process_job_inner(job)


def _process_job_inner(job):
    job_id = job.get("job_id")
    camera_id_int = job.get("camera_id")
    callback_url = job.get("callback_url")
    input_type = job.get("input_type")
    # Recording start time now arrives in every dispatch (Pruthil,
    # 2026-09-12) -- present for a timestamped upload_video/archive_clip,
    # null for an un-timestamped upload_video or any photo. Only ever
    # combined with elapsed_video_seconds (set by _run_video) below when
    # both are actually available; never guessed otherwise.
    recording_start_time = job.get("recording_start_time")
    recording_start_dt = _parse_iso8601(recording_start_time) if recording_start_time else None
    # See the gate wiring at module load: bypassed for a single photo
    # (one look at each vehicle, a false skip there is unrecoverable),
    # active for video/archive_clip (many sampled frames per vehicle,
    # real speed win, real A/B evidence the accuracy cost is
    # negligible). Thread-local, not a shared flag -- concurrent jobs of
    # different input_types must not affect each other's gate setting.
    _gate_state.bypass = (input_type == "upload_image")
    tmp_path = None
    try:
        # Plate-lookup jobs give us backend-registry's real numeric
        # camera_id directly -- unlike the live pipeline (which only
        # knows a "direct-camNN" stream name and needs CAMERA_ID_MAP to
        # resolve it), there's no string to resolve here, and this id
        # isn't guaranteed to even be one of our own 30 mapped cameras
        # (confirmed by Pruthil: routing it through CAMERA_ID_MAP first
        # broke on a real camera_id, 109858, outside that map entirely).
        # Passed straight through everywhere a numeric camera_id is
        # needed.
        if input_type == "upload_image":
            tmp_path = _download_to_temp(job["file_url"], ".jpg", headers={"X-Internal-Key": INTERNAL_KEY})
            # NOT detect_plate() -- that wrapper picks whichever vehicle
            # box has the LARGEST area, plate or not, which is correct
            # for its actual purpose (single-vehicle ground-truth test
            # images, see its own docstring) but wrong here: a real
            # manual-lookup photo can have multiple vehicles, and a real
            # bug this way threw away a plate ml-anpr read successfully
            # ("GJ27DB0906", pattern-matched) because a different,
            # bigger vehicle with no visible plate happened to occupy
            # more pixels in the same frame. Same "only keep boxes that
            # actually read a plate" filter _run_video already uses
            # below, applied to a single frame instead of a stream.
            img = cv2.imread(tmp_path)
            if img is None:
                raise ValueError(f"Could not read image at {tmp_path}")
            confirmed = [r for r in detect_plate_from_frame(img, img) if r.get("plate_number")]
            for r in confirmed:
                r["box_area"] = _box_area_fraction(r.get("box"), img.shape)
        elif input_type == "upload_video":
            tmp_path = _download_to_temp(job["file_url"], ".mp4", headers={"X-Internal-Key": INTERNAL_KEY})
            confirmed = _run_video(tmp_path)
        elif input_type == "archive_clip":
            tmp_path = _download_to_temp(job["clip_url"], ".mp4")
            confirmed = _run_video(tmp_path)
        else:
            raise ValueError(f"Unknown input_type: {input_type}")

        if not confirmed:
            _patch_callback(callback_url, {"status": "failed", "error_message": "No plate found"})
            return

        # Every confirmed plate gets its own POST /detections -- same as
        # the live video pipeline (streaming.py posts once per confirmed
        # vehicle track, never just "the best one"). A photo or clip can
        # genuinely have more than one real, distinct plate in frame
        # (confirmed directly: a real two-vehicle test image where BOTH
        # plates were clearly visible and both read correctly), and
        # discarding all but one would silently drop real detections
        # from the shared table, not just from this job's own summary.
        posted = []
        for r in confirmed:
            # detected_at: required per-result for a timestamped
            # video/clip (the real in-footage moment), omitted for an
            # un-timestamped upload_video or any photo -- per Pruthil's
            # contract (2026-09-12). Never time.time(): that's exactly
            # the "now(), not the real capture moment" mistake the
            # contract explicitly warns against, so this only gets
            # computed when both a real anchor (recording_start_time)
            # and a real offset (elapsed_video_seconds, from
            # _run_video) actually exist -- otherwise left unset, not
            # guessed. Computed BEFORE building the event (not just for
            # the callback afterward) so it actually reaches the
            # detection database via to_backend_payload(), not only the
            # job's own summary -- a real gap found in review: this used
            # to land in the callback only.
            detected_at = None
            if recording_start_dt is not None and r.get("elapsed_video_seconds") is not None:
                detected_at_dt = recording_start_dt + timedelta(seconds=r["elapsed_video_seconds"])
                detected_at = _format_iso8601(detected_at_dt)

            event = DetectionEvent(
                camera_id=str(camera_id_int),
                plate_number=r["plate_number"],
                confidence=r.get("confidence"),
                detection_type=r.get("note", ""),
                # Deterministic, not a fresh random UUID -- see
                # _job_event_id's own docstring. Makes a retried job
                # (same job_id, same plates) a safe no-op resend on
                # backend-watchlist's side instead of a duplicate row.
                event_id=_job_event_id(job_id, r["plate_number"]),
                detected_at=detected_at,
            )
            response = requests.post(
                DETECTION_API_URL, json=event.to_backend_payload(camera_id_int),
                headers={"X-Internal-Key": INTERNAL_KEY}, timeout=REQUEST_TIMEOUT_SEC,
            )
            if response.status_code not in (201, 409):
                print(f"[WARN] POST /detections returned {response.status_code} for "
                      f"plate {r['plate_number']!r}: {response.text[:200]}")
                continue
            if response.status_code == 409:
                # Real collision, not our own retry: this event_id is
                # derived from (job_id, plate_number), so a 409 here
                # means a DIFFERENT detection already legitimately owns
                # it -- per the handoff's own guidance (see
                # watchlist_client.py), retrying with the same id just
                # repeats the same conflict, so this plate is skipped
                # rather than silently misreported as our own.
                print(f"[WARN] event_id collision (409) for plate {r['plate_number']!r} -- "
                      f"not our own detection, skipping")
                continue
            result = {
                "detection_id": response.json()["detection"]["id"],
                "plate_number": r["plate_number"],
                "confidence": r.get("confidence"),
            }
            if r.get("box_area") is not None:
                result["box_area"] = r["box_area"]
            if detected_at is not None:
                result["detected_at"] = detected_at
            posted.append(result)

        if not posted:
            _patch_callback(callback_url, {
                "status": "failed",
                "error_message": "Plate(s) read but backend-watchlist rejected every POST /detections call",
            })
            return

        # New multi-result contract (Pruthil, 2026-09-12): every plate
        # actually posted above goes in the results list -- the old
        # single detection_id/plate_number shape isn't validated
        # server-side anymore and was silently accepted as "completed, 0
        # plates found," which looked like a missed detection on the
        # frontend even though the model read it correctly.
        _patch_callback(callback_url, {
            "status": "completed",
            "results": posted,
        })
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        _patch_callback(callback_url, {"status": "failed", "error_message": str(e)})
    finally:
        if tmp_path is not None and os.path.exists(tmp_path):
            os.remove(tmp_path)


class JobsHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # quiet, matches label_crops_web.py

    def do_POST(self):
        if self.path != "/jobs/run":
            self.send_response(404)
            self.end_headers()
            return
        if self.headers.get("X-Internal-Key") != INTERNAL_KEY:
            self.send_response(401)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            job = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return

        self.send_response(202)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"status": "accepted", "job_id": job.get("job_id")}).encode())

        threading.Thread(target=_process_job, args=(job,), daemon=True).start()


def serve(port=8002):
    print(f"Listening for jobs on http://localhost:{port}/jobs/run")
    ThreadingHTTPServer(("0.0.0.0", port), JobsHandler).serve_forever()


if __name__ == "__main__":
    serve()
