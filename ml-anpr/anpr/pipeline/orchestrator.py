"""Top-level wiring for the scalable pipeline: N FrameReaders (one per
camera) -> a shared InferenceWorkerPool (M workers, cameras hashed
across them) -> one EventSender. This is the new, separate,
horizontally-scalable entry point P3 asked for -- it does not replace
anpr.streaming's process_stream/process_video_file/process_hls_stream,
which stay as they are for the existing single-camera use.
"""
import time

from .event_sender import EventSender
from .frame_source import FrameReader
from .inference_worker import InferenceWorkerPool, _ctx
from .metrics import Metrics, safe_qsize


class ScalablePipeline:
    """
    cameras: list of (camera_id_str, source_url) tuples -- camera_id_str
        must be a key in anpr.config.CAMERA_ID_MAP for events to actually
        reach the backend (see EventSender/events.py); an unmapped
        camera_id still runs real inference, it just can't deliver
        events, same fail-safe-not-fail-crash behavior as the existing
        anpr.watchlist_client.send_detection_to_watchlist.
    num_workers: how many inference workers to spread `cameras` across
        (item 3). Sensible default is min(len(cameras), cpu_count),
        left as an explicit required arg here rather than guessed, since
        the right number depends on real hardware this runs on.
    sample_every_n: passed straight to every FrameReader (item 2).
    """

    def __init__(self, cameras, num_workers, sample_every_n=15,
                 frame_queue_maxsize=200, event_queue_maxsize=2000,
                 confirm_threshold=2, window_size=10,
                 event_sender_kwargs=None):
        self.metrics = Metrics()
        # multiprocessing.Queue, not queue.Queue -- InferenceWorkers run as
        # separate processes now (see inference_worker.py) and need to put
        # confirmed events onto this queue from across a process boundary.
        # EventSender (a thread in this process) draining it works
        # unchanged either way -- multiprocessing.Queue supports the same
        # get(timeout=...)/empty() calls it already uses.
        self.event_queue = _ctx.Queue(maxsize=event_queue_maxsize)

        self.worker_pool = InferenceWorkerPool(
            num_workers, self.event_queue, self.metrics,
            confirm_threshold=confirm_threshold, window_size=window_size,
        )

        self.readers = []
        for camera_id, source in cameras:
            worker = self.worker_pool.worker_for(camera_id)
            reader = FrameReader(
                source, camera_id, worker.frame_queue, self.metrics,
                sample_every_n=sample_every_n,
            )
            self.readers.append(reader)

        self.event_sender = EventSender(
            self.event_queue, self.metrics, **(event_sender_kwargs or {})
        )

    def start(self):
        self.worker_pool.start()
        self.event_sender.start()
        for r in self.readers:
            r.start()
        return self

    def stop(self):
        for r in self.readers:
            r.stop()
        self.worker_pool.stop()
        self.event_sender.stop()

    def report(self):
        """A representative frame-queue depth (there's one per worker,
        not one global queue -- report the busiest one, since that's the
        one that matters for spotting a worker falling behind)."""
        queues = [w.frame_queue for w in self.worker_pool.workers]
        busiest_frame_queue = max(queues, key=lambda q: safe_qsize(q) or 0, default=None) if queues else None
        return self.metrics.snapshot(frame_queue=busiest_frame_queue, event_queue=self.event_queue)

    def tracker_summary(self):
        """Per-camera vehicle/plate-candidate/confirmed-by-tier counts.
        Each InferenceWorker runs in a separate process (see
        inference_worker.py) and reports its trackers' final state back
        over a queue only on stop() -- so this reflects live data mid-run
        only for workers that have already reported at least once, and is
        complete only after stop(). Call after run_for()/stop() for the
        real, final presentation numbers."""
        summary = {}
        for worker in self.worker_pool.workers:
            summary.update(worker.tracker_summary)
        return summary

    def run_for(self, duration_sec, report_interval_sec=5):
        """Convenience for a bounded demo/test run -- starts, prints a
        metrics snapshot every report_interval_sec, stops after
        duration_sec, returns the final snapshot."""
        self.start()
        try:
            elapsed = 0
            while elapsed < duration_sec:
                time.sleep(min(report_interval_sec, duration_sec - elapsed))
                elapsed += report_interval_sec
                print(f"[{elapsed}s] {self.report()}")
        finally:
            self.stop()
        print(f"Per-camera summary: {self.tracker_summary()}")
        return self.report()
