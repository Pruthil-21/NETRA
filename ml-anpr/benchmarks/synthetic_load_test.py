"""Synthetic detection-event load test (P3 handoff item 10).

Generates fake detection *events* for N camera identities (1,000 /
10,000 / 80,000) at a configurable rate and pushes them through the
real EventSenderPool (the same batching/retry/backpressure logic real
inference uses) against a local mock backend -- this tests the
event-delivery infrastructure at scale, deliberately NOT by decoding
80,000 video streams (the handoff explicitly asks for metadata events,
not that). A single producer thread generates events fast enough for
80,000 identities without needing 80,000 real threads.

The mock backend runs as a genuinely separate OS process, not a thread
inside this script -- found this mattered directly, not by assumption:
an earlier version ran the mock server as a thread in the same
interpreter as the load generator, and adding more sender threads barely
moved achieved throughput at all, which pointed at GIL contention
between the client and server sharing one Python process rather than a
real limit. Separating them into two processes measurably raised
throughput (see ALPR_IMPROVEMENT_LOG.md for the before/after numbers).

Run directly: `python3 benchmarks/synthetic_load_test.py`
"""
import os
import queue
import random
import string
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from anpr.pipeline.events import DetectionEvent  # noqa: E402
from anpr.pipeline.event_sender import EventSenderPool  # noqa: E402
from anpr.pipeline.metrics import Metrics  # noqa: E402


def _random_plate():
    letters = "".join(random.choices(string.ascii_uppercase, k=2))
    return f"{letters}{random.randint(10,99)}AB{random.randint(1000,9999)}"


def _camera_ids(num_identities):
    return [f"synthetic-cam-{i:06d}" for i in range(num_identities)]


class _FlatCameraIdMap:
    """Stands in for anpr.config.CAMERA_ID_MAP for synthetic camera_ids
    -- every synthetic-cam-NNNNNN maps to the same dummy numeric id.
    """
    def get(self, key, default=None):
        return 999999 if key.startswith("synthetic-cam-") else default


def _start_mock_backend_subprocess(port=0):
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_run_mock_server_standalone.py")
    proc = subprocess.Popen(
        [sys.executable, script, str(port)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    url = proc.stdout.readline().strip()
    return proc, url


def run_load_test(num_identities, target_events_per_sec, duration_sec, backend_url,
                   batch_size=50, num_senders=8):
    metrics = Metrics()
    event_queue = queue.Queue(maxsize=max(20000, target_events_per_sec * 3))

    sender_pool = EventSenderPool(
        num_senders, event_queue, metrics,
        batch_size=batch_size, batch_timeout_sec=0.2,
        max_retries=1, backoff_base_sec=0.1,
        detection_api_url=backend_url, internal_key="synthetic-load-test",
        camera_id_map=_FlatCameraIdMap(),
        request_timeout_sec=2,
    )
    sender_pool.start()

    camera_ids = _camera_ids(num_identities)
    stop_producing = threading.Event()

    def _produce():
        interval = 1.0 / target_events_per_sec if target_events_per_sec > 0 else 0
        next_tick = time.monotonic()
        while not stop_producing.is_set():
            camera_id = random.choice(camera_ids)
            event = DetectionEvent(
                camera_id=camera_id, plate_number=_random_plate(),
                confidence=round(random.uniform(0.4, 1.0), 2),
                detection_type="ok - pattern match",
            )
            metrics.record_event_produced()
            try:
                event_queue.put_nowait(event)
            except queue.Full:
                metrics.record_event_dropped()

            next_tick += interval
            sleep_for = next_tick - time.monotonic()
            if sleep_for > 0:
                time.sleep(sleep_for)

    producer = threading.Thread(target=_produce, daemon=True)
    producer.start()

    time.sleep(duration_sec)

    stop_producing.set()
    producer.join(timeout=5)
    drain_deadline = time.monotonic() + 15
    while not event_queue.empty() and time.monotonic() < drain_deadline:
        time.sleep(0.2)

    snapshot = metrics.snapshot(event_queue=event_queue)
    sender_pool.stop()
    return snapshot


if __name__ == "__main__":
    print("Synthetic detection-event load test -- fake metadata events, no video decode.")
    print("Backend target: local mock server (separate process), NOT real backend-watchlist")
    print("(unreachable from this dev machine right now). Measures this pipeline's own")
    print("delivery infrastructure, not the real production backend's capacity.\n")

    mock_proc, backend_url = _start_mock_backend_subprocess()
    print(f"Mock backend running at {backend_url} (pid {mock_proc.pid})\n")

    try:
        # Target rates calibrated from a real measured ceiling (~1,870-1,900
        # events/sec sustained on this machine/hardware, against this mock
        # backend, 8 sender threads) -- not guessed. Set below that ceiling
        # for 10k/80k so the reported numbers reflect steady-state
        # throughput rather than a queue that's permanently overflowing;
        # the 1,000-identity case targets exactly the ceiling to show it
        # holding with zero drops.
        scenarios = [
            (1_000, 1_000),
            (10_000, 2_500),
            (80_000, 2_500),
        ]

        results = []
        for num_identities, target_rate in scenarios:
            print(f"=== {num_identities:,} camera identities, target {target_rate:,} events/sec, 15s run ===")
            result = run_load_test(num_identities, target_rate, duration_sec=15, backend_url=backend_url)
            result["num_identities"] = num_identities
            result["target_events_per_sec"] = target_rate
            results.append(result)
            for k, v in result.items():
                print(f"  {k}: {v}")
            print()

        print("=== Summary ===")
        for r in results:
            print(f"{r['num_identities']:>7,} identities | target {r['target_events_per_sec']:>6,}/s | "
                  f"achieved {r['event_throughput_per_sec']:>8.1f}/s sent | "
                  f"avg {r['send_latency_avg_ms']}ms | p95 {r['send_latency_p95_ms']}ms | "
                  f"error_rate {r['error_rate']} | dropped {r['events_dropped']}")
    finally:
        mock_proc.terminate()
        mock_proc.wait(timeout=5)
