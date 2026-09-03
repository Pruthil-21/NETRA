"""Frame reading, decoupled from inference (P3 handoff items 1 and 2).

Runs in its own thread per camera, reading as fast as the source allows
and pushing sampled frames onto a shared bounded queue that inference
workers pull from -- reading and inference are two independent stages
now, not one blocking chain like anpr/streaming.py's existing
process_stream/process_hls_stream/process_video_file (those stay
untouched; this is a new, separate layer for the scalable/multi-camera
case, not a replacement for the existing single-camera entry points).
"""
import queue
import threading
import time

import cv2


class FrameReader:
    """One instance per camera source. `sample_every_n` is the
    configurable sampling rate (item 2) -- e.g. 15 means "keep 1 out of
    every 15 frames", same semantics as process_video_file's existing
    process_every_n_frames, just extracted so it can run independently
    of the inference stage.

    Backpressure (item 7): if the frame queue is full (inference is
    falling behind), a full frame is dropped rather than blocking this
    reader thread -- a stalled reader would mean stale/backed-up frames
    for every other camera sharing the same downstream worker pool, and
    a live camera can't be paused anyway, so dropping the newest frame
    and moving on is the only sane choice. Counted, not silent -- see
    Metrics.frames_dropped.
    """

    def __init__(self, source, camera_id, frame_queue, metrics, sample_every_n=1,
                 reconnect_interval_sec=2.0, max_reconnect_attempts=10):
        self.source = source
        self.camera_id = camera_id
        self.frame_queue = frame_queue
        self.metrics = metrics
        self.sample_every_n = max(1, sample_every_n)
        self.reconnect_interval_sec = reconnect_interval_sec
        self.max_reconnect_attempts = max_reconnect_attempts
        self._stop_event = threading.Event()
        self._thread = None

    def start(self):
        self._thread = threading.Thread(target=self._run, name=f"FrameReader-{self.camera_id}", daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _open(self):
        for attempt in range(1, self.max_reconnect_attempts + 1):
            if self._stop_event.is_set():
                return None
            cap = cv2.VideoCapture(self.source)
            if cap.isOpened():
                return cap
            cap.release()
            time.sleep(self.reconnect_interval_sec)
        return None

    def _run(self):
        cap = self._open()
        if cap is None:
            return

        frame_count = 0
        try:
            while not self._stop_event.is_set():
                ret, frame = cap.read()
                if not ret:
                    cap.release()
                    cap = self._open()
                    if cap is None:
                        return
                    continue

                frame_count += 1
                if frame_count % self.sample_every_n != 0:
                    continue

                self.metrics.record_frame_read()
                try:
                    self.frame_queue.put_nowait((self.camera_id, frame, time.time()))
                except queue.Full:
                    self.metrics.record_frame_dropped()
        finally:
            cap.release()
