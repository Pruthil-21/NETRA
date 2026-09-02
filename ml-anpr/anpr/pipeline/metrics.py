"""Thread-safe metrics collection for the scalable pipeline (P3 handoff
item 9: throughput, latency, queue depth, error rate, dropped-frame
count). Plain stdlib (threading.Lock + collections.deque), no new
dependency -- same reasoning as everywhere else in this project that
picked stdlib over pulling in a metrics library for a hackathon-scope
demo: this needs to be readable and correct, not a production
observability stack.
"""
import threading
import time
from collections import deque


def _percentile(sorted_values, pct):
    """Nearest-rank percentile on an already-sorted list. Returns None on
    empty input rather than raising -- callers snapshot metrics that may
    not have any samples yet (e.g. right at startup)."""
    if not sorted_values:
        return None
    idx = min(len(sorted_values) - 1, int(round(pct / 100.0 * (len(sorted_values) - 1))))
    return sorted_values[idx]


class Metrics:
    """One instance shared across all stages of one pipeline run (frame
    readers, inference workers, event sender). Every mutating method is
    lock-protected; snapshot() is the only thing callers should read from
    for reporting, so a report always reflects one consistent instant
    rather than torn reads across counters.

    Latency samples are kept in bounded deques (maxlen) rather than
    growing unboundedly across a long run -- recent behavior is what
    matters for p95/throughput reporting, not the full history of a
    multi-hour run.
    """

    def __init__(self, latency_window=2000):
        self._lock = threading.Lock()
        self._start_time = time.monotonic()

        self.frames_read = 0
        self.frames_dropped = 0
        self.frames_processed = 0

        self.events_produced = 0
        self.events_sent = 0
        self.events_failed = 0
        self.events_retried = 0
        self.events_dropped = 0  # event queue was full -- backpressure, not a crash

        self._inference_latencies = deque(maxlen=latency_window)
        self._send_latencies = deque(maxlen=latency_window)

    def record_frame_read(self):
        with self._lock:
            self.frames_read += 1

    def record_frame_dropped(self):
        with self._lock:
            self.frames_dropped += 1

    def record_inference(self, latency_sec):
        with self._lock:
            self.frames_processed += 1
            self._inference_latencies.append(latency_sec)

    def record_event_produced(self):
        with self._lock:
            self.events_produced += 1

    def record_event_dropped(self):
        with self._lock:
            self.events_dropped += 1

    def record_event_sent(self, latency_sec):
        with self._lock:
            self.events_sent += 1
            self._send_latencies.append(latency_sec)

    def record_event_failed(self):
        with self._lock:
            self.events_failed += 1

    def record_event_retried(self):
        with self._lock:
            self.events_retried += 1

    def snapshot(self, frame_queue=None, event_queue=None):
        """A single consistent read of everything, plus derived stats
        (throughput, avg/p95 latency, error rate). Queue objects are
        passed in rather than held by Metrics itself -- keeps this class
        decoupled from the pipeline's specific queue wiring, callers
        just pass whatever queues they want depth reported for.
        """
        with self._lock:
            elapsed = max(1e-9, time.monotonic() - self._start_time)
            inference_sorted = sorted(self._inference_latencies)
            send_sorted = sorted(self._send_latencies)

            total_send_attempts = self.events_sent + self.events_failed
            error_rate = (self.events_failed / total_send_attempts) if total_send_attempts else 0.0

            return {
                "elapsed_sec": round(elapsed, 2),
                "frames_read": self.frames_read,
                "frames_dropped": self.frames_dropped,
                "frames_processed": self.frames_processed,
                "frame_throughput_per_sec": round(self.frames_processed / elapsed, 2),
                "inference_latency_avg_ms": round(1000 * sum(inference_sorted) / len(inference_sorted), 2) if inference_sorted else None,
                "inference_latency_p95_ms": round(1000 * _percentile(inference_sorted, 95), 2) if inference_sorted else None,
                "events_produced": self.events_produced,
                "events_sent": self.events_sent,
                "events_failed": self.events_failed,
                "events_retried": self.events_retried,
                "events_dropped": self.events_dropped,
                "event_throughput_per_sec": round(self.events_sent / elapsed, 2),
                "send_latency_avg_ms": round(1000 * sum(send_sorted) / len(send_sorted), 2) if send_sorted else None,
                "send_latency_p95_ms": round(1000 * _percentile(send_sorted, 95), 2) if send_sorted else None,
                "error_rate": round(error_rate, 4),
                "frame_queue_depth": frame_queue.qsize() if frame_queue is not None else None,
                "event_queue_depth": event_queue.qsize() if event_queue is not None else None,
            }
