"""A tiny local stand-in for backend-watchlist's POST /detections,
used only for the synthetic load test (benchmarks/synthetic_load_test.py).

Why this exists: backend-watchlist isn't reachable from this dev machine
right now (it runs on a different machine behind its own Cloudflare
tunnel -- see ALPR_IMPROVEMENT_LOG.md). Without something reachable to
send to, the load test couldn't produce any real measured numbers at
all. This measures OUR pipeline's own queueing/batching/retry
infrastructure's throughput and latency -- it is explicitly NOT a
measurement of the real production backend's capacity, which depends on
its own infrastructure and is a separate concern. Every report this
produces says so.

Stdlib only (http.server + threading), no new dependency, matching
every other choice in this pipeline.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # silence per-request logging -- would drown out load-test output at scale

    def do_POST(self):
        if self.path != "/detections":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)  # drain the body, content not actually needed by the mock

        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"detection": {}, "alert": None}).encode())


class MockBackendServer:
    def __init__(self, host="localhost", port=0):
        self._server = ThreadingHTTPServer((host, port), _Handler)
        self._thread = None

    @property
    def url(self):
        host, port = self._server.server_address
        return f"http://{host}:{port}/detections"

    def start(self):
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self._server.shutdown()
        self._server.server_close()
