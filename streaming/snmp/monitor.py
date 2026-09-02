#!/usr/bin/env python3
import json
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

TARGETS_FILE = Path(os.environ.get("SNMP_TARGETS_FILE", "/config/targets.json"))
MANIFEST_FILE = Path(os.environ.get("CAMERA_MANIFEST", "/recordings/cameras.json"))
PORT = int(os.environ.get("SNMP_MONITOR_PORT", "9116"))


def now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_config():
    with TARGETS_FILE.open(encoding="utf-8") as config_file:
        config = json.load(config_file)
    if config.get("mode", "mock") != "mock":
        raise RuntimeError("Only mock mode is enabled until real SNMPv3 device access is available.")
    limit = config.get("camera_limit", 30)
    if not isinstance(limit, int) or limit < 1:
        raise RuntimeError("camera_limit must be a positive integer.")
    return config, limit


def load_cameras(limit):
    cameras = []
    if MANIFEST_FILE.is_file():
        try:
            manifest = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
            if isinstance(manifest, list):
                for item in manifest:
                    camera_id = str(item.get("id", "")).strip()
                    if camera_id:
                        cameras.append({"id": camera_id, "name": str(item.get("name", camera_id))})
        except (json.JSONDecodeError, OSError):
            pass
    present = {camera["id"] for camera in cameras}
    for number in range(1, limit + 1):
        camera_id = f"cam{number:02d}"
        if camera_id not in present:
            cameras.append({"id": camera_id, "name": f"NETRA Camera {number:02d}"})
    return cameras[:limit]


def metrics(camera_id):
    seed = sum(ord(character) for character in camera_id)
    return {
        "cpu_percent": 18 + seed % 41,
        "memory_percent": 24 + seed % 37,
        "network_mbps": round(1.5 + (seed % 80) / 10, 1),
        "temperature_celsius": 36 + seed % 16,
    }


def devices():
    config, limit = load_config()
    states = config.get("mock_states", {})
    checked_at = now()
    result = []
    for camera in load_cameras(limit):
        online = states.get(camera["id"], "online") == "online"
        result.append(
            {
                "id": camera["id"],
                "name": camera["name"],
                "status": "online" if online else "offline",
                "reachable": online,
                "snmp_mode": "mock",
                "snmp_state": "simulated",
                "metrics": metrics(camera["id"]) if online else None,
                "last_checked_at": checked_at,
            }
        )
    return result


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status_code, payload):
        encoded = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            result = devices()
        except (OSError, RuntimeError, json.JSONDecodeError) as error:
            self.send_json(503, {"status": "error", "message": str(error)})
            return
        if path == "/healthz":
            self.send_json(200, {"status": "ok", "mode": "mock", "simulated": True, "target_count": len(result), "checked_at": now()})
            return
        if path == "/v1/devices":
            self.send_json(200, {"mode": "mock", "simulated": True, "device_count": len(result), "devices": result})
            return
        if path.startswith("/v1/devices/"):
            camera_id = path.rsplit("/", 1)[-1]
            for device in result:
                if device["id"] == camera_id:
                    self.send_json(200, device)
                    return
            self.send_json(404, {"status": "not_found", "id": camera_id})
            return
        self.send_json(404, {"status": "not_found", "available_endpoints": ["/healthz", "/v1/devices", "/v1/devices/{id}"]})

    def log_message(self, format_string, *args):
        return


if __name__ == "__main__":
    print(f"NETRA SNMP monitor running in mock mode on port {PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
