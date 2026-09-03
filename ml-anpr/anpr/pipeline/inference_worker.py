"""Inference workers, decoupled from both frame reading and event
sending (P3 handoff item 3: distribute cameras across multiple workers).

Reuses the existing, already-tested detection/tracking code unchanged
(anpr.detection.detect_plate_from_frame, anpr.tracking.VehicleTracker) --
this module is purely about *how many threads pull frames and run that
existing logic*, not a reimplementation of the detection logic itself.

Design note on why each camera is pinned to one worker (not a single
shared frame queue drained by N workers): VehicleTracker keeps
frame-to-frame state per camera (IoU box matching, confirmation
clusters) that depends on processing that camera's frames in order, one
at a time. Letting frames from the same camera be picked up by whichever
worker happens to be free would let two workers touch the same tracker
concurrently (not thread-safe) and process that camera's frames
out of order (breaks the IoU matching this tracker depends on). Instead,
each camera is hashed to exactly one worker up front, so a given
camera's tracker is only ever touched by one thread -- the actual
horizontal scaling P3 asked for is real (N independent workers, load
spread across them by camera), it's just camera-level parallelism
rather than frame-level.

GPU note: this demo runs worker threads sharing anpr.config's single
already-loaded model/device (this Mac only has one MPS device to test
against). True multi-GPU distribution would need one model instance per
worker pinned to its own device -- the worker-pool structure here is
what that would plug into, but that specific extension isn't exercised
on this hardware.
"""
import queue
import threading
import time

from ..detection import detect_plate_from_frame
from ..tracking import VehicleTracker
from .events import DetectionEvent, MODEL_VERSION


class InferenceWorker:
    """One worker = one thread + one dedicated frame queue + its own set
    of per-camera VehicleTracker instances (only cameras routed to this
    worker ever appear here)."""

    def __init__(self, worker_id, event_queue, metrics, confirm_threshold=2, window_size=10):
        self.worker_id = worker_id
        self.frame_queue = queue.Queue(maxsize=200)
        self.event_queue = event_queue
        self.metrics = metrics
        self.confirm_threshold = confirm_threshold
        self.window_size = window_size
        self.trackers = {}  # camera_id -> VehicleTracker, only this worker's cameras
        self._stop_event = threading.Event()
        self._thread = None

    def start(self):
        self._thread = threading.Thread(target=self._run, name=f"InferenceWorker-{self.worker_id}", daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def submit(self, camera_id, frame, read_at):
        """Called by the router (InferenceWorkerPool), not directly by
        FrameReader -- see pool docstring for the camera->worker hashing."""
        try:
            self.frame_queue.put_nowait((camera_id, frame, read_at))
            return True
        except queue.Full:
            return False

    def _run(self):
        while not self._stop_event.is_set():
            try:
                camera_id, frame, read_at = self.frame_queue.get(timeout=1)
            except queue.Empty:
                continue

            t0 = time.monotonic()
            results = detect_plate_from_frame(frame, frame)
            tracker = self.trackers.get(camera_id)
            if tracker is None:
                tracker = VehicleTracker(window_size=self.window_size, confirm_threshold=self.confirm_threshold)
                self.trackers[camera_id] = tracker

            confirmed = tracker.update(results, raw_frame=frame) + tracker.pop_ready_vlm_confirmations()
            self.metrics.record_inference(time.monotonic() - t0)

            for c in confirmed:
                event = DetectionEvent(
                    camera_id=camera_id,
                    plate_number=c["plate_number"],
                    confidence=c["confidence"],
                    detection_type=c["note"],
                )
                self.metrics.record_event_produced()
                try:
                    self.event_queue.put_nowait(event)
                except queue.Full:
                    self.metrics.record_event_dropped()


class InferenceWorkerPool:
    """Owns N InferenceWorkers and routes each camera_id to exactly one
    of them (stable hash, not round-robin -- a camera must always land
    on the same worker for its whole lifetime so its tracker state stays
    coherent; round-robin per-frame would scatter one camera's frames
    across trackers)."""

    def __init__(self, num_workers, event_queue, metrics, confirm_threshold=2, window_size=10):
        self.workers = [
            InferenceWorker(i, event_queue, metrics, confirm_threshold, window_size)
            for i in range(num_workers)
        ]

    def start(self):
        for w in self.workers:
            w.start()
        return self

    def stop(self):
        for w in self.workers:
            w.stop()

    def worker_for(self, camera_id):
        return self.workers[hash(camera_id) % len(self.workers)]

    def submit(self, camera_id, frame, read_at):
        """Returns False (caller should count as dropped) if that
        camera's assigned worker is backed up."""
        return self.worker_for(camera_id).submit(camera_id, frame, read_at)
