"""Talks to the standalone mock SNMP monitor (streaming/snmp/monitor.py,
see streaming/snmp/README.md) -- a separate container that simulates
CPU/memory/network/temperature for cam01..camNN since the Organizer doesn't
expose real SNMP endpoints yet. It runs (or doesn't) independently of this
API, so every call here is defensive: an unreachable monitor is a normal,
expected state (the demo container just isn't started), never a 500.
"""
import httpx

from ..config import settings

_TIMEOUT_SECONDS = 3.0


def get_devices() -> dict:
    try:
        response = httpx.get(f"{settings.snmp_monitor_url}/v1/devices", timeout=_TIMEOUT_SECONDS)
        response.raise_for_status()
    except httpx.HTTPError:
        return {"available": False, "devices": []}
    return {"available": True, "devices": response.json().get("devices", [])}


def get_device_for_camera(camera_id: int) -> dict | None:
    """The monitor's own device ids are cam01..camNN (zero-padded, see
    monitor.py's load_cameras) -- this registry's Organizer-demo camera ids
    (1..30) line up with that numbering by construction, so a zero-padded
    id is the join key. Returns None both when the monitor is unreachable
    and when it simply has no device at that id -- callers show the same
    "nothing to display" state either way."""
    devices = get_devices()
    if not devices["available"]:
        return None
    target_id = f"cam{camera_id:02d}"
    for device in devices["devices"]:
        if device.get("id") == target_id:
            return device
    return None
