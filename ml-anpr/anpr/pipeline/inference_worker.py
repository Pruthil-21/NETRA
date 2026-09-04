"""Inference workers, decoupled from both frame reading and event
sending (P3 handoff item 3: distribute cameras across multiple workers).

Reuses the existing, already-tested detection/tracking code unchanged
(anpr.detection.detect_plate_from_frame, anpr.tracking.VehicleTracker) --
this module is purely about *how many workers pull frames and run that
existing logic*, not a reimplementation of the detection logic itself.

Runs each worker as a separate OS PROCESS, not a thread -- required, not
a nice-to-have. Real testing on the GPU server (see
ALPR_IMPROVEMENT_LOG.md) found that thread-based workers caused
catastrophic slowdown, not just "no speedup": 2 threads on a Quadro RTX
8000 with 49GB free dropped per-frame inference from ~100+ fps (one
camera alone) to ~0.2 fps combined (two threads), 96% of frames dropped.
nvidia-smi showed near-zero GPU memory used throughout -- this was never
a memory constraint, it was Python's GIL (only one thread runs Python
bytecode at a time, no matter how many CPU cores or how much GPU memory
exist) plus likely non-GIL-releasing contention inside PaddleOCR's
pre/post-processing. Separate processes bypass the GIL entirely -- each
worker gets its own interpreter and its own CUDA context, genuine
parallel execution.

Uses multiprocessing's 'spawn' start method explicitly, not the Linux
default 'fork': CUDA does not support being used in a fork()'d process
once a CUDA context is initialized in the parent (undefined behavior,
common source of hangs/crashes) -- spawn starts each worker as a
genuinely fresh interpreter that initializes CUDA itself, avoiding that
whole class of bug. This costs a slower startup (each worker re-imports
and re-loads the model) but that's a one-time cost, not a per-frame one.

Design note on why each camera is pinned to one worker (unchanged from
the thread-based version): VehicleTracker keeps frame-to-frame state per
camera (IoU box matching, confirmation clusters) that depends on
processing that camera's frames in order, one at a time. Each camera is
hashed to exactly one worker up front, so a given camera's tracker is
only ever touched by one process.

Cost of processes over threads: no shared memory, so everything that
used to be a direct attribute/method call across worker <-> main process
now goes through a multiprocessing.Queue instead -- frames in (paying a
real pickling cost per frame, unavoidable for any multi-process video
pipeline), confirmed events out, and periodic stats out (see
_stats_queue below, which bridges inference latency, event
produced/dropped counts, and each worker's final per-camera tracker
summary back to the main process's real Metrics object and
ScalablePipeline.tracker_summary()).
"""
import multiprocessing as mp
import queue
import threading
import time

from ..detection import detect_plate_from_frame
from ..tracking import VehicleTracker
from .events import DetectionEvent

# One context used everywhere in this module so every queue/process/event
# created here agrees on the same (spawn) start method.
_ctx = mp.get_context("spawn")


def _worker_loop(frame_queue, event_queue, stats_queue, stop_event, confirm_threshold, window_size):
    """Runs inside the child process. Model loading (via the
    detect_plate_from_frame import above) happens fresh here, once per
    process -- not inherited or shared from the parent."""
    trackers = {}  # camera_id -> VehicleTracker, this process's cameras only

    while not stop_event.is_set():
        try:
            camera_id, frame, read_at = frame_queue.get(timeout=1)
        except queue.Empty:
            continue

        t0 = time.monotonic()
        results = detect_plate_from_frame(frame, frame)
        tracker = trackers.get(camera_id)
        if tracker is None:
            tracker = VehicleTracker(window_size=window_size, confirm_threshold=confirm_threshold)
            trackers[camera_id] = tracker

        confirmed = tracker.update(results, raw_frame=frame) + tracker.pop_ready_vlm_confirmations()

        try:
            stats_queue.put_nowait(("inference", time.monotonic() - t0))
        except queue.Full:
            pass

        for c in confirmed:
            event = DetectionEvent(
                camera_id=camera_id, plate_number=c["plate_number"],
                confidence=c["confidence"], detection_type=c["note"],
            )
            try:
                event_queue.put_nowait(event)
                stats_queue.put_nowait(("event_produced", None))
            except queue.Full:
                try:
                    stats_queue.put_nowait(("event_dropped", None))
                except queue.Full:
                    pass

    # Shutdown: this process's tracker state (vehicles tracked, plate
    # candidates, confirmed-by-tier, confirmed plates) only exists in this
    # process's memory -- report it back before exiting, or it's gone.
    summary = {
        camera_id: {
            "vehicles_tracked": t.total_vehicles_tracked,
            "plate_candidates": t.total_plate_candidates,
            "confirmed_by_tier": dict(t.confirmed_by_tier),
            "confirmed_plates": sorted(t.confirmed_plates),
        }
        for camera_id, t in trackers.items()
    }
    stats_queue.put(("tracker_summary", summary))


class InferenceWorker:
    """One worker = one child process + one dedicated frame queue.
    Public interface (start/stop/submit/frame_queue) intentionally
    mirrors the old thread-based version so callers didn't need to
    change -- tracker_summary is new (see docstring on _worker_loop for
    why it can't just be a live attribute like it was when workers were
    threads sharing the parent's memory)."""

    def __init__(self, worker_id, event_queue, metrics, confirm_threshold=2, window_size=10):
        self.worker_id = worker_id
        self.frame_queue = _ctx.Queue(maxsize=200)
        self.event_queue = event_queue
        self.metrics = metrics
        self.confirm_threshold = confirm_threshold
        self.window_size = window_size
        self.tracker_summary = {}  # populated on stop(), from the child's final report

        self._stats_queue = _ctx.Queue(maxsize=1000)
        self._stop_event = _ctx.Event()
        self._process = None
        self._stats_thread_stop = threading.Event()
        self._stats_thread = None

    def start(self):
        self._process = _ctx.Process(
            target=_worker_loop,
            args=(self.frame_queue, self.event_queue, self._stats_queue,
                  self._stop_event, self.confirm_threshold, self.window_size),
            name=f"InferenceWorker-{self.worker_id}",
            daemon=True,
        )
        self._process.start()

        # Bridges the process boundary: drains this worker's stats queue
        # into the real, thread-safe, main-process Metrics object -- a
        # plain thread is fine here (and simpler than a Manager), since
        # this only ever runs in the main process.
        self._stats_thread = threading.Thread(target=self._drain_stats, daemon=True)
        self._stats_thread.start()
        return self

    def _drain_stats(self):
        while not self._stats_thread_stop.is_set():
            try:
                kind, payload = self._stats_queue.get(timeout=1)
            except queue.Empty:
                continue
            if kind == "inference":
                self.metrics.record_inference(payload)
            elif kind == "event_produced":
                self.metrics.record_event_produced()
            elif kind == "event_dropped":
                self.metrics.record_event_dropped()
            elif kind == "tracker_summary":
                self.tracker_summary = payload

    def stop(self):
        self._stop_event.set()
        if self._process is not None:
            self._process.join(timeout=10)
            if self._process.is_alive():
                # The worker loop only checks stop_event between
                # frame_queue.get() calls, not mid-inference -- a stuck
                # or unusually slow inference call could miss the 10s
                # window. Force it rather than leaving a zombie process
                # (and its held CUDA context/GPU memory) behind.
                self._process.terminate()
                self._process.join(timeout=5)
        # One last non-blocking drain so the tracker_summary the process
        # reports right before exiting isn't missed by a stats thread
        # that's about to be told to stop.
        try:
            while True:
                kind, payload = self._stats_queue.get_nowait()
                if kind == "tracker_summary":
                    self.tracker_summary = payload
        except queue.Empty:
            pass
        self._stats_thread_stop.set()

        # Real bug hit on the GPU server, not hypothetical: frame_queue
        # is routinely left full (200 real image arrays) when a run
        # stops -- nothing will ever read the rest now that the worker
        # process is gone. Without this, multiprocessing.Queue's
        # background feeder thread blocks the whole Python process at
        # exit trying to flush that backlog through the pipe -- observed
        # directly as a run that printed its final summary correctly and
        # then hung for 10+ minutes until manually killed. This tells the
        # queue not to bother flushing on the way out.
        self.frame_queue.cancel_join_thread()
        self._stats_queue.cancel_join_thread()

    def submit(self, camera_id, frame, read_at):
        """Called by the router (InferenceWorkerPool), not directly by
        FrameReader -- see pool docstring for the camera->worker hashing."""
        try:
            self.frame_queue.put_nowait((camera_id, frame, read_at))
            return True
        except queue.Full:
            return False


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
