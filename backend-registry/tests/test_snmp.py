import httpx
import pytest

from app.services import snmp_service


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def test_snmp_devices_requires_auth(client):
    resp = client.get("/snmp/devices")
    assert resp.status_code == 401


def test_snmp_devices_reports_unavailable_when_monitor_is_unreachable(client, viewer_headers, monkeypatch):
    def fake_get(*args, **kwargs):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(snmp_service.httpx, "get", fake_get)
    resp = client.get("/snmp/devices", headers=viewer_headers)
    assert resp.status_code == 200
    assert resp.json() == {"available": False, "devices": []}


def test_snmp_devices_returns_the_monitors_device_list(client, viewer_headers, monkeypatch):
    payload = {"devices": [{"id": "cam01", "status": "online", "metrics": {"cpu_percent": 42}}]}
    monkeypatch.setattr(snmp_service.httpx, "get", lambda *a, **k: _FakeResponse(payload))
    resp = client.get("/snmp/devices", headers=viewer_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is True
    assert body["devices"] == payload["devices"]


def test_camera_health_maps_camera_id_to_the_monitors_zero_padded_device_id(client, viewer_headers, monkeypatch):
    payload = {"devices": [
        {"id": "cam01", "status": "online"},
        {"id": "cam02", "status": "offline"},
    ]}
    monkeypatch.setattr(snmp_service.httpx, "get", lambda *a, **k: _FakeResponse(payload))
    resp = client.get("/cameras/2/health", headers=viewer_headers)
    assert resp.status_code == 200
    assert resp.json() == {"id": "cam02", "status": "offline"}


def test_camera_health_404s_when_the_monitor_has_no_matching_device(client, viewer_headers, monkeypatch):
    monkeypatch.setattr(snmp_service.httpx, "get", lambda *a, **k: _FakeResponse({"devices": []}))
    resp = client.get("/cameras/999/health", headers=viewer_headers)
    assert resp.status_code == 404


def test_camera_health_404s_when_the_monitor_is_unreachable(client, viewer_headers, monkeypatch):
    def fake_get(*args, **kwargs):
        raise httpx.ConnectTimeout("timed out")

    monkeypatch.setattr(snmp_service.httpx, "get", fake_get)
    resp = client.get("/cameras/1/health", headers=viewer_headers)
    assert resp.status_code == 404
