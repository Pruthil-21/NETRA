import httpx
import pytest

from app.services import recordings_service


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def test_camera_recordings_requires_auth(client):
    resp = client.get("/cameras/1/recordings")
    assert resp.status_code == 401


def test_camera_recordings_404s_for_a_camera_that_does_not_exist(client, viewer_headers):
    resp = client.get("/cameras/999999/recordings", headers=viewer_headers)
    assert resp.status_code == 404


def test_camera_recordings_reports_unavailable_when_playback_server_is_unreachable(
    client, viewer_headers, officer_headers, monkeypatch, gap_analysis_test_cameras
):
    def fake_get(*args, **kwargs):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(recordings_service.httpx, "get", fake_get)

    created = client.post(
        "/cameras",
        json={
            "name": "Recordings Test Camera", "dept": "Traffic Police", "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
            "stream_id": "42",
        },
        headers=officer_headers,
    ).json()
    gap_analysis_test_cameras.append(created["id"])

    resp = client.get(f"/cameras/{created['id']}/recordings", headers=viewer_headers)
    assert resp.status_code == 200
    assert resp.json() == {"available": False, "segments": []}


def test_camera_recordings_returns_no_segments_when_camera_has_no_stream_id(client, viewer_headers, officer_headers, gap_analysis_test_cameras):
    created = client.post(
        "/cameras",
        json={
            "name": "No Stream Id Camera", "dept": "Traffic Police", "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
        },
        headers=officer_headers,
    ).json()
    gap_analysis_test_cameras.append(created["id"])

    resp = client.get(f"/cameras/{created['id']}/recordings", headers=viewer_headers)
    assert resp.status_code == 200
    assert resp.json() == {"available": False, "segments": []}


def test_camera_recordings_returns_the_playback_servers_segment_list(client, viewer_headers, officer_headers, monkeypatch, gap_analysis_test_cameras):
    segments = [{"start": "2026-09-05T08:00:00Z", "duration": 600.0}]
    monkeypatch.setattr(recordings_service.httpx, "get", lambda *a, **k: _FakeResponse(segments))

    created = client.post(
        "/cameras",
        json={
            "name": "Has Recordings Camera", "dept": "Traffic Police", "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
            "stream_id": "7",
        },
        headers=officer_headers,
    ).json()
    gap_analysis_test_cameras.append(created["id"])

    resp = client.get(f"/cameras/{created['id']}/recordings", headers=viewer_headers)
    assert resp.status_code == 200
    assert resp.json() == {"available": True, "segments": segments}
