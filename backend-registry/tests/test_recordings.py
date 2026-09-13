import httpx
from app.services import recordings_service


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def _rbac_headers(role, permissions, scope_type="platform", scope_value=None, sub="rec-test-1"):
    import jwt as pyjwt
    from app.config import settings

    token = pyjwt.encode(
        {"sub": sub, "badge_number": f"GJ-{role}", "role": role,
         "scope_type": scope_type, "scope_value": scope_value, "permissions": permissions},
        settings.jwt_secret, algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def test_camera_recordings_requires_auth(client):
    resp = client.get("/cameras/1/recordings")
    assert resp.status_code == 401


def test_camera_recordings_404s_for_a_camera_that_does_not_exist(client, viewer_headers):
    resp = client.get("/cameras/999999/recordings", headers=viewer_headers)
    assert resp.status_code == 404


def test_camera_recordings_reports_unavailable_when_service_unset(
    client, viewer_headers, officer_headers, gap_analysis_test_cameras
):
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
    assert resp.json() == {"available": False, "segments": [], "service_reachable": False}


def test_camera_recordings_reports_unavailable_when_service_unreachable(
    client, viewer_headers, officer_headers, monkeypatch, gap_analysis_test_cameras
):
    monkeypatch.setenv("RECORDING_SERVICE_URL", "http://recording.invalid")
    monkeypatch.setenv("RECORDING_SERVICE_KEY", "test-key")

    def fake_get(*args, **kwargs):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(recordings_service.httpx, "get", fake_get)

    created = client.post(
        "/cameras",
        json={
            "name": "Recordings Test Camera 2", "dept": "Traffic Police", "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
            "stream_id": "43",
        },
        headers=officer_headers,
    ).json()
    gap_analysis_test_cameras.append(created["id"])

    resp = client.get(f"/cameras/{created['id']}/recordings", headers=viewer_headers)
    assert resp.status_code == 200
    assert resp.json() == {"available": False, "segments": [], "service_reachable": False}


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
    assert resp.json() == {"available": False, "segments": [], "service_reachable": False}


def test_camera_recordings_returns_the_recording_services_segment_list(
    client, viewer_headers, officer_headers, monkeypatch, gap_analysis_test_cameras
):
    monkeypatch.setenv("RECORDING_SERVICE_URL", "http://recording.invalid")
    monkeypatch.setenv("RECORDING_SERVICE_KEY", "test-key")

    segments = [{"start": "2026-09-05T08:00:00Z", "duration": 600.0, "url": "https://playback.example/get?token=abc"}]
    captured = {}

    def fake_get(url, params=None, headers=None, timeout=None):
        captured["url"] = url
        captured["params"] = params
        captured["headers"] = headers
        return _FakeResponse(segments)

    monkeypatch.setattr(recordings_service.httpx, "get", fake_get)

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
    assert resp.json() == {"available": True, "segments": segments, "service_reachable": True}
    assert captured["url"] == "http://recording.invalid/list"
    # The recording service's own `path` convention is "stream/<id>",
    # matching every other stream_id consumer (frontend-map's
    # getHlsStreamUrl, MediaMTX itself) -- the bare id alone 404s there.
    assert captured["params"]["path"] == "stream/7"
    assert captured["headers"]["X-Service-Key"] == "test-key"
    assert "X-Actor-ID" in captured["headers"]
    # Cloudflare (fronting the recording service) rejects generic
    # Python-library user agents -- this must never regress back to
    # httpx's own default.
    assert captured["headers"]["User-Agent"] == "DIGDHRISHTI-Registry/1.0"


def test_camera_recordings_forwards_explicit_start_and_end(
    client, viewer_headers, officer_headers, monkeypatch, gap_analysis_test_cameras
):
    monkeypatch.setenv("RECORDING_SERVICE_URL", "http://recording.invalid")
    monkeypatch.setenv("RECORDING_SERVICE_KEY", "test-key")

    captured = {}

    def fake_get(url, params=None, headers=None, timeout=None):
        captured["params"] = params
        return _FakeResponse([])

    monkeypatch.setattr(recordings_service.httpx, "get", fake_get)

    created = client.post(
        "/cameras",
        json={
            "name": "Ranged Recordings Camera", "dept": "Traffic Police", "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
            "stream_id": "8",
        },
        headers=officer_headers,
    ).json()
    gap_analysis_test_cameras.append(created["id"])

    resp = client.get(
        f"/cameras/{created['id']}/recordings",
        params={"start": "2026-09-05T08:00:00Z", "end": "2026-09-05T09:00:00Z"},
        headers=viewer_headers,
    )
    assert resp.status_code == 200
    assert captured["params"]["start"] == "2026-09-05T08:00:00Z"
    assert captured["params"]["end"] == "2026-09-05T09:00:00Z"


def test_camera_recordings_distinguishes_service_unreachable_from_genuinely_empty(
    client, viewer_headers, officer_headers, monkeypatch, gap_analysis_test_cameras
):
    """service_reachable is the field the frontend uses to tell "the
    recording service is down" apart from "this camera really has no
    footage in range" -- both used to collapse into the same
    available: False, len(segments) == 0 shape."""
    monkeypatch.setenv("RECORDING_SERVICE_URL", "http://recording.invalid")
    monkeypatch.setenv("RECORDING_SERVICE_KEY", "test-key")
    monkeypatch.setattr(recordings_service.httpx, "get", lambda *a, **k: _FakeResponse([]))

    created = client.post(
        "/cameras",
        json={
            "name": "Genuinely Empty Camera", "dept": "Traffic Police", "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
            "stream_id": "78",
        },
        headers=officer_headers,
    ).json()
    gap_analysis_test_cameras.append(created["id"])

    resp = client.get(f"/cameras/{created['id']}/recordings", headers=viewer_headers)
    assert resp.status_code == 200
    # Reachable (a real response came back), just legitimately empty --
    # distinct from the unset/unreachable cases above, both of which report
    # service_reachable: False even though they also have segments: [].
    assert resp.json() == {"available": False, "segments": [], "service_reachable": True}


def test_camera_recordings_denied_for_officer_outside_camera_district(
    client, officer_headers, gap_analysis_test_cameras
):
    created = client.post(
        "/cameras",
        json={
            "name": "Anand Only Camera", "dept": "Anand", "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
            "stream_id": "9",
        },
        headers=officer_headers,
    ).json()
    gap_analysis_test_cameras.append(created["id"])

    token_headers = _rbac_headers("station_officer", ["view_live_feeds"], scope_type="district", scope_value="Ahmedabad")
    resp = client.get(f"/cameras/{created['id']}/recordings", headers=token_headers)
    assert resp.status_code == 403


def test_camera_recordings_allowed_for_officer_posted_to_the_cameras_district(
    client, officer_headers, monkeypatch, gap_analysis_test_cameras
):
    monkeypatch.setenv("RECORDING_SERVICE_URL", "http://recording.invalid")
    monkeypatch.setenv("RECORDING_SERVICE_KEY", "test-key")
    monkeypatch.setattr(recordings_service.httpx, "get", lambda *a, **k: _FakeResponse([]))

    created = client.post(
        "/cameras",
        json={
            "name": "Ahmedabad Camera", "dept": "Ahmedabad", "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
            "stream_id": "10",
        },
        headers=officer_headers,
    ).json()
    gap_analysis_test_cameras.append(created["id"])

    token_headers = _rbac_headers("station_officer", ["view_live_feeds"], scope_type="district", scope_value="Ahmedabad")
    resp = client.get(f"/cameras/{created['id']}/recordings", headers=token_headers)
    assert resp.status_code == 200


def test_internal_recording_clip_url_requires_internal_key(client):
    resp = client.get(
        "/internal/cameras/1/recording-clip-url",
        params={"start": "2026-09-05T08:00:00Z", "end": "2026-09-05T09:00:00Z"},
    )
    assert resp.status_code == 422  # missing X-Internal-Key header entirely


def test_internal_recording_clip_url_rejects_wrong_key(client):
    resp = client.get(
        "/internal/cameras/1/recording-clip-url",
        params={"start": "2026-09-05T08:00:00Z", "end": "2026-09-05T09:00:00Z"},
        headers={"X-Internal-Key": "wrong-key"},
    )
    assert resp.status_code == 401


def test_internal_recording_clip_url_returns_none_for_unknown_camera(client):
    from app.config import settings

    resp = client.get(
        "/internal/cameras/999999/recording-clip-url",
        params={"start": "2026-09-05T08:00:00Z", "end": "2026-09-05T09:00:00Z"},
        headers={"X-Internal-Key": settings.internal_service_key},
    )
    assert resp.status_code == 200
    assert resp.json() == {"url": None}


def test_internal_recording_clip_url_returns_the_recording_services_first_segment(
    client, officer_headers, monkeypatch, gap_analysis_test_cameras
):
    from app.config import settings
    from app.services import recordings_service

    segments = [{"start": "2026-09-05T08:00:00Z", "duration": 600.0, "url": "https://playback.example/get?token=fresh"}]
    monkeypatch.setenv("RECORDING_SERVICE_URL", "http://recording.invalid")
    monkeypatch.setenv("RECORDING_SERVICE_KEY", "test-key")
    monkeypatch.setattr(recordings_service.httpx, "get", lambda *a, **k: _FakeResponse(segments))

    created = client.post(
        "/cameras",
        json={
            "name": "Internal Clip URL Test Camera", "dept": "Traffic Police", "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
            "stream_id": "77",
        },
        headers=officer_headers,
    ).json()
    gap_analysis_test_cameras.append(created["id"])

    resp = client.get(
        f"/internal/cameras/{created['id']}/recording-clip-url",
        params={"start": "2026-09-05T08:00:00Z", "end": "2026-09-05T08:10:00Z"},
        headers={"X-Internal-Key": settings.internal_service_key},
    )
    assert resp.status_code == 200
    assert resp.json() == {"url": "https://playback.example/get?token=fresh"}


def test_camera_recording_health_requires_auth(client):
    resp = client.get("/cameras/1/recordings/health")
    assert resp.status_code == 401


def test_camera_recording_health_404s_when_service_unset(client, viewer_headers, officer_headers, gap_analysis_test_cameras):
    created = client.post(
        "/cameras",
        json={
            "name": "Health Test Camera", "dept": "Traffic Police", "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
            "stream_id": "44",
        },
        headers=officer_headers,
    ).json()
    gap_analysis_test_cameras.append(created["id"])

    resp = client.get(f"/cameras/{created['id']}/recordings/health", headers=viewer_headers)
    assert resp.status_code == 404


def test_camera_recording_health_returns_the_services_payload(
    client, viewer_headers, officer_headers, monkeypatch, gap_analysis_test_cameras
):
    monkeypatch.setenv("RECORDING_SERVICE_URL", "http://recording.invalid")
    monkeypatch.setenv("RECORDING_SERVICE_KEY", "test-key")
    monkeypatch.setattr(recordings_service.httpx, "get", lambda *a, **k: _FakeResponse({"status": "recording"}))

    created = client.post(
        "/cameras",
        json={
            "name": "Health Ok Camera", "dept": "Traffic Police", "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
            "stream_id": "45",
        },
        headers=officer_headers,
    ).json()
    gap_analysis_test_cameras.append(created["id"])

    resp = client.get(f"/cameras/{created['id']}/recordings/health", headers=viewer_headers)
    assert resp.status_code == 200
    assert resp.json() == {"status": "recording"}
