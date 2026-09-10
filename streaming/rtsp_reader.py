#!/usr/bin/env python3
"""
DIGDHRISHTI RTSP frame reader for the ANPR / ML pipeline.
Provides non-blocking threaded frame grabbing, buffer clearing, and dual-resolution scaling.
"""

import time
import threading
import cv2
from typing import Optional, Tuple


class RTSPStreamReader:
    def __init__(
        self,
        rtsp_url: str,
        inference_dim: Tuple[int, int] = (640, 360),
        reconnect_interval_sec: float = 2.0,
        max_frame_age_sec: float = 2.0,
        io_timeout_ms: int = 3000,
    ):
        """
        :param rtsp_url: RTSP stream URI (e.g., rtsp://localhost:8554/stream/16)
        :param inference_dim: (width, height) target for downstream YOLO detection
        :param reconnect_interval_sec: Backoff interval for auto-reconnect
        """
        self.rtsp_url = rtsp_url
        self.inference_dim = inference_dim
        self.reconnect_interval = reconnect_interval_sec
        if reconnect_interval_sec <= 0 or max_frame_age_sec <= 0 or io_timeout_ms <= 0:
            raise ValueError("Reconnect, freshness and I/O timeouts must be positive")
        if len(inference_dim) != 2 or any(d <= 0 for d in inference_dim):
            raise ValueError("Inference dimensions must be positive")
        self.max_frame_age = max_frame_age_sec
        self.io_timeout_ms = io_timeout_ms
        self._last_frame_monotonic = 0.0
        self._stop = threading.Event()

        self._cap: Optional[cv2.VideoCapture] = None
        self._frame_raw: Optional[cv2.Mat] = None
        self._frame_infer: Optional[cv2.Mat] = None
        self._lock = threading.Lock()
        self._running = False
        self._thread: Optional[threading.Thread] = None

        self.fps: float = 0.0
        self.frame_count: int = 0
        self.last_frame_time: float = 0.0

    def start(self) -> "RTSPStreamReader":
        if self._thread and self._thread.is_alive():
            if self._stop.is_set():
                raise RuntimeError("Previous capture thread is still stopping")
            return self
        self._stop.clear()
        self._running = True
        self._thread = threading.Thread(target=self._capture_worker, daemon=True)
        self._thread.start()
        return self

    def _open_capture(self) -> bool:
        # Force TCP transport to avoid UDP packet loss/jitter
        import os
        os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay")
        self._cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG, [
            cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, self.io_timeout_ms,
            cv2.CAP_PROP_READ_TIMEOUT_MSEC, self.io_timeout_ms,
        ])
        self._cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return self._cap.isOpened()

    def _capture_worker(self):
        try:
            self._capture_loop()
        finally:
            if self._cap is not None:
                self._cap.release()
                self._cap = None
            self._clear_frames()
            self._running = False

    def _clear_frames(self):
        with self._lock:
            self._frame_raw = self._frame_infer = None
            self.fps = 0.0
            self._last_frame_monotonic = 0.0

    def _capture_loop(self):
        while not self._stop.is_set():
            if self._cap is None or not self._cap.isOpened():
                if not self._open_capture():
                    self._cap.release()
                    self._cap = None
                    self._clear_frames()
                    self._stop.wait(self.reconnect_interval)
                    continue

            # Read latest frame
            ret, frame = self._cap.read()
            if not ret or frame is None:
                # Stream stalled or disconnected, release and retry
                if self._cap:
                    self._cap.release()
                self._cap = None
                self._clear_frames()
                self._stop.wait(self.reconnect_interval)
                continue

            # Fast downscale for YOLO/inference
            infer_frame = cv2.resize(
                frame, self.inference_dim, interpolation=cv2.INTER_LINEAR
            )

            # Publish a consistent raw/resized pair to the consumer.
            with self._lock:
                now = time.monotonic()
                elapsed = now - self._last_frame_monotonic
                self.fps = 1.0 / elapsed if self._last_frame_monotonic and elapsed > 0 else 0.0
                self._last_frame_monotonic = now
                self._frame_raw = frame
                self._frame_infer = infer_frame
                self.frame_count += 1
                self.last_frame_time = time.time()

    def read_latest(self) -> Tuple[bool, Optional[cv2.Mat], Optional[cv2.Mat]]:
        """
        Non-blocking read.
        :return: (is_available, raw_frame_for_ocr, resized_frame_for_detection)
        """
        with self._lock:
            if (self._stop.is_set() or self._frame_raw is None or self._frame_infer is None
                    or time.monotonic() - self._last_frame_monotonic > self.max_frame_age):
                return False, None, None
            return True, self._frame_raw.copy(), self._frame_infer.copy()

    def stop(self):
        self._running = False
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=self.io_timeout_ms / 1000 + 1)
        # Only the capture thread releases VideoCapture; never race a read().
        self._clear_frames()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="DIGDHRISHTI RTSP ingest test consumer")
    parser.add_argument(
        "--url",
        type=str,
        default="rtsp://localhost:8554/stream/16",
        help="Target RTSP URL",
    )
    args = parser.parse_args()

    print(f"Connecting to RTSP Stream: {args.url}")
    stream = RTSPStreamReader(rtsp_url=args.url).start()

    try:
        prev_time = time.time()
        while True:
            ready, raw_frame, infer_frame = stream.read_latest()
            if not ready:
                time.sleep(0.01)
                continue

            # Simulate simulated ML inference delay (e.g. 50ms)
            time.sleep(0.05)

            curr_time = time.time()
            instant_fps = 1.0 / (curr_time - prev_time)
            prev_time = curr_time

            # Show inference view with stats
            h, w = infer_frame.shape[:2]
            raw_h, raw_w = raw_frame.shape[:2]
            cv2.putText(
                infer_frame,
                f"Detection: {w}x{h} | Source: {raw_w}x{raw_h} | FPS: {instant_fps:.1f}",
                (15, 25),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (0, 255, 0),
                2,
            )

            cv2.imshow("ANPR inference preview", infer_frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break

    finally:
        stream.stop()
        cv2.destroyAllWindows()
