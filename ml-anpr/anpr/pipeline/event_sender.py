"""Async, batched, retrying event delivery (P3 handoff items 4, 6, 7, 8).

Honest limitation, not glossed over: real backend-watchlist's
POST /detections (see contract/API_CONTRACT.md) has no client-supplied
idempotency key in its documented contract -- the only server-side dedup
it does is for scripted *replay* scenarios, keyed on
(scenario_run_id, camera_id, plate_number), not for arbitrary retries of
a live detection. That means "retry without creating duplicate
detections" (item 6) can only be a best-effort *client-side* guarantee
here, not an absolute one: if a POST times out, this client genuinely
cannot know whether the server received and processed it before the
connection dropped. What this module actually does about that:

- A clean network failure (connection refused, DNS failure -- the
  request definitely never reached the server) is always safe to retry.
- A timeout (request may have reached the server, response just never
  came back) is retried too, since for a security-alert pipeline losing
  a real detection is worse than an occasional duplicate row -- but this
  is a real, deliberate tradeoff, not a guarantee of no duplicates.
- Within one process's lifetime, a local "already-confirmed-sent" set
  keyed on event_id stops this client from re-sending something it
  already got a real 201 for, even if a caller mistakenly resubmits it.

The real fix for full duplicate-safety would be a server-side
idempotency key in the contract (e.g. accept and dedup on event_id) --
flagged as a genuine ask for P6, not solved unilaterally here.
"""
import queue
import threading
import time

import requests

from ..config import CAMERA_ID_MAP, DETECTION_API_URL, INTERNAL_KEY


class EventSender:
    """Pulls DetectionEvents off event_queue, batches them (item 8:
    up to batch_size events or batch_timeout_sec, whichever comes
    first), and POSTs each with retry+backoff. One event = one HTTP
    request still (the real contract's POST /detections takes one
    detection per call, not a batch endpoint) -- "batching" here means
    draining a whole batch off the queue in one shot and sending it as a
    tight burst, not a single combined request; that's the honest
    extent of batching this contract supports without a backend change.

    Backpressure (item 7): if the *event* queue itself is full (this
    sender is falling behind, e.g. backend is slow/down), producers
    (InferenceWorker) drop new events rather than blocking -- counted
    via Metrics.events_dropped, never a crash.
    """

    def __init__(self, event_queue, metrics, batch_size=10, batch_timeout_sec=1.0,
                 max_retries=3, backoff_base_sec=0.5, detection_api_url=None,
                 internal_key=None, camera_id_map=None, request_timeout_sec=3,
                 dry_run=False, mock_send_fn=None):
        self.event_queue = event_queue
        self.metrics = metrics
        self.batch_size = batch_size
        self.batch_timeout_sec = batch_timeout_sec
        self.max_retries = max_retries
        self.backoff_base_sec = backoff_base_sec
        self.detection_api_url = detection_api_url or DETECTION_API_URL
        self.internal_key = internal_key or INTERNAL_KEY
        self.camera_id_map = camera_id_map if camera_id_map is not None else CAMERA_ID_MAP
        self.request_timeout_sec = request_timeout_sec
        # dry_run + mock_send_fn: for the synthetic load test, which
        # needs to exercise this exact batching/retry/backpressure logic
        # at 80,000-identity scale without actually depending on a real
        # (rate-limited, possibly unreachable) production backend for
        # every single call. mock_send_fn(event) -> (success: bool)
        # stands in for the real HTTP call when set.
        self.dry_run = dry_run
        self.mock_send_fn = mock_send_fn

        self._sent_event_ids = set()  # best-effort local idempotency, see module docstring
        self._sent_ids_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread = None
        # A plain requests.post() call opens a fresh TCP connection every
        # time -- measured directly via the synthetic load test: adding
        # more EventSenders barely moved the achieved throughput at all
        # (~1,300/s regardless of sender count), which pointed at a
        # per-call cost independent of thread count, not a
        # parallelism/GIL limit. A persistent Session with keep-alive
        # connection pooling fixed it -- see the before/after numbers in
        # ALPR_IMPROVEMENT_LOG.md.
        self._session = requests.Session()

    def start(self):
        self._thread = threading.Thread(target=self._run, name="EventSender", daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=10)

    def _collect_batch(self):
        batch = []
        deadline = time.monotonic() + self.batch_timeout_sec
        while len(batch) < self.batch_size:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                batch.append(self.event_queue.get(timeout=remaining))
            except queue.Empty:
                break
        return batch

    def _run(self):
        while not self._stop_event.is_set() or not self.event_queue.empty():
            batch = self._collect_batch()
            for event in batch:
                self._send_with_retry(event)

    def _already_sent(self, event_id):
        with self._sent_ids_lock:
            return event_id in self._sent_event_ids

    def _mark_sent(self, event_id):
        with self._sent_ids_lock:
            self._sent_event_ids.add(event_id)
            # Bounded, not unbounded growth over a long-running process --
            # this is a best-effort in-process guard, not a durable store,
            # so an old ID falling out of this set after a long run just
            # means we lose that specific guard for a very old event, not
            # a correctness issue for the pipeline's actual runtime window.
            if len(self._sent_event_ids) > 50000:
                self._sent_event_ids.clear()

    def _send_with_retry(self, event):
        if self._already_sent(event.event_id):
            return

        numeric_camera_id = self.camera_id_map.get(event.camera_id)
        if numeric_camera_id is None:
            print(f"[WARN] No numeric camera_id mapped for '{event.camera_id}', dropping event {event.event_id}")
            self.metrics.record_event_failed()
            return

        payload = event.to_backend_payload(numeric_camera_id)
        headers = {"X-Internal-Key": self.internal_key}

        for attempt in range(self.max_retries + 1):
            t0 = time.monotonic()
            try:
                if self.dry_run:
                    ok = self.mock_send_fn(event) if self.mock_send_fn else True
                else:
                    response = self._session.post(
                        self.detection_api_url, json=payload, headers=headers,
                        timeout=self.request_timeout_sec,
                    )
                    ok = response.status_code == 201
                    if not ok:
                        print(f"[WARN] Unexpected response {response.status_code} for event {event.event_id}")

                if ok:
                    self.metrics.record_event_sent(time.monotonic() - t0)
                    self._mark_sent(event.event_id)
                    return
            except requests.exceptions.RequestException as e:
                if attempt == 0:
                    print(f"[WARN] Send failed for event {event.event_id}: {e}")

            if attempt < self.max_retries:
                self.metrics.record_event_retried()
                time.sleep(self.backoff_base_sec * (2 ** attempt))

        self.metrics.record_event_failed()


class EventSenderPool:
    """Multiple EventSenders pulling from the same shared event_queue.
    Unlike InferenceWorkerPool (which must pin each camera to one
    worker for tracker-state coherence), event sending has no such
    constraint -- any sender can deliver any event, in any order,
    without correctness issues, so a plain shared queue.Queue (itself
    thread-safe) is enough; no per-sender routing needed.

    Exists because a single EventSender is bottlenecked by sequential
    HTTP round-trips -- measured directly via the synthetic load test
    (benchmarks/synthetic_load_test.py): one sender capped out around
    ~1,200-1,300 events/sec regardless of how many camera identities or
    how high the target rate was, purely from one thread doing one
    blocking POST at a time. Multiple senders parallelize that.
    """

    def __init__(self, num_senders, event_queue, metrics, **event_sender_kwargs):
        self.senders = [
            EventSender(event_queue, metrics, **event_sender_kwargs)
            for _ in range(num_senders)
        ]

    def start(self):
        for s in self.senders:
            s.start()
        return self

    def stop(self):
        for s in self.senders:
            s.stop()
