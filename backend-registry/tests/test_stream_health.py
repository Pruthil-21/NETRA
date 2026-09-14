import asyncio

import httpx
from app.services import stream_health_service


class _FakeResponse:
    def __init__(self, status_code):
        self.status_code = status_code


def _fake_async_get(status_code=200, capture: dict | None = None):
    """Builds an httpx.AsyncClient.get replacement -- check_hls_reachable now
    calls the async client method, not the module-level httpx.get the sync
    version used, so tests patch the class method directly (applies
    regardless of where the AsyncClient instance is constructed)."""
    async def fake_get(self, url, timeout=None, follow_redirects=None):
        if capture is not None:
            capture["url"] = url
        return _FakeResponse(status_code)
    return fake_get


def test_live_check_requires_auth(client):
    resp = client.get("/cameras/1/live-check")
    assert resp.status_code == 401


def test_live_check_404s_for_a_camera_that_does_not_exist(client, viewer_headers):
    resp = client.get("/cameras/999999/live-check", headers=viewer_headers)
    assert resp.status_code == 404


def test_live_check_false_when_camera_has_no_stream_url(client, viewer_headers, officer_headers, gap_analysis_test_cameras):
    created = client.post(
        "/cameras",
        json={
            "name": "No Stream Camera", "dept": "Traffic Police", "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
        },
        headers=officer_headers,
    ).json()
    gap_analysis_test_cameras.append(created["id"])

    resp = client.get(f"/cameras/{created['id']}/live-check", headers=viewer_headers)
    assert resp.status_code == 200
    assert resp.json() == {"reachable": False}


def test_live_check_true_only_on_a_real_200_from_the_manifest(
    client, viewer_headers, officer_headers, monkeypatch, gap_analysis_test_cameras
):
    # This is the exact bug being fixed: the old client-side no-cors probe
    # treated ANY response (a 404 included) as "reachable". A real
    # server-side check must not.
    created = client.post(
        "/cameras",
        json={
            "name": "Stream Camera", "dept": "Traffic Police", "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
            "stream_id": "cam42",
        },
        headers=officer_headers,
    ).json()
    gap_analysis_test_cameras.append(created["id"])

    captured = {}
    monkeypatch.setattr(httpx.AsyncClient, "get", _fake_async_get(404, captured))
    resp = client.get(f"/cameras/{created['id']}/live-check", headers=viewer_headers)
    assert resp.status_code == 200
    assert resp.json() == {"reachable": False}
    assert captured["url"].endswith("/stream/cam42/index.m3u8")

    # check_hls_reachable caches by URL for a few seconds (see
    # stream_health_service._CACHE_TTL_SECONDS) so two pollers checking the
    # same camera a moment apart don't each pay a fresh network round trip --
    # bypass it here since this test is deliberately simulating the stream
    # coming online between two checks, not two near-simultaneous callers.
    stream_health_service._cache.clear()
    monkeypatch.setattr(httpx.AsyncClient, "get", _fake_async_get(200))
    resp = client.get(f"/cameras/{created['id']}/live-check", headers=viewer_headers)
    assert resp.json() == {"reachable": True}


def test_live_check_prefers_hls_url_when_set(client, viewer_headers, officer_headers, monkeypatch, gap_analysis_test_cameras):
    created = client.post(
        "/cameras",
        json={
            "name": "Full Url Camera", "dept": "Traffic Police", "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
            "stream_id": "should-be-ignored", "hls_url": "https://elsewhere.example/stream/x/index.m3u8",
        },
        headers=officer_headers,
    ).json()
    gap_analysis_test_cameras.append(created["id"])

    captured = {}
    stream_health_service._cache.clear()
    monkeypatch.setattr(httpx.AsyncClient, "get", _fake_async_get(200, captured))
    resp = client.get(f"/cameras/{created['id']}/live-check", headers=viewer_headers)
    assert resp.json() == {"reachable": True}
    assert captured["url"] == "https://elsewhere.example/stream/x/index.m3u8"


def test_check_hls_reachable_treats_a_network_error_as_unreachable(monkeypatch):
    async def fake_get(self, url, timeout=None, follow_redirects=None):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    stream_health_service._cache.clear()

    async def run():
        async with httpx.AsyncClient() as client:
            return await stream_health_service.check_hls_reachable(client, "https://example.com/stream/x/index.m3u8")

    assert asyncio.run(run()) is False


def test_check_hls_reachable_caches_within_the_ttl(monkeypatch):
    stream_health_service._cache.clear()
    calls = []

    async def fake_get(self, url, timeout=None, follow_redirects=None):
        calls.append(url)
        return _FakeResponse(200)

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    url = "https://example.com/stream/cache-test/index.m3u8"

    async def run():
        async with httpx.AsyncClient() as client:
            first = await stream_health_service.check_hls_reachable(client, url)
            second = await stream_health_service.check_hls_reachable(client, url)
            return first, second

    first, second = asyncio.run(run())
    assert first is True
    assert second is True
    assert len(calls) == 1, "a second check within the TTL must not hit the network again"


def test_check_hls_reachable_rechecks_once_the_ttl_expires(monkeypatch):
    stream_health_service._cache.clear()
    calls = []

    async def fake_get(self, url, timeout=None, follow_redirects=None):
        calls.append(url)
        return _FakeResponse(200)

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(stream_health_service, "_CACHE_TTL_SECONDS", 0)
    url = "https://example.com/stream/cache-expiry-test/index.m3u8"

    async def run():
        async with httpx.AsyncClient() as client:
            first = await stream_health_service.check_hls_reachable(client, url)
            second = await stream_health_service.check_hls_reachable(client, url)
            return first, second

    first, second = asyncio.run(run())
    assert first is True
    assert second is True
    assert len(calls) == 2, "a TTL of 0 must force a fresh check every call"


def test_test_stream_requires_auth(client):
    resp = client.post("/cameras/test-stream", json={"stream_id": "cam42"})
    assert resp.status_code == 401


def test_test_stream_false_with_neither_field_set(client, viewer_headers):
    resp = client.post("/cameras/test-stream", json={}, headers=viewer_headers)
    assert resp.status_code == 200
    assert resp.json() == {"reachable": False}


def test_test_stream_checks_a_stream_id_not_attached_to_any_camera(client, viewer_headers, monkeypatch):
    captured = {}
    stream_health_service._cache.clear()
    monkeypatch.setattr(httpx.AsyncClient, "get", _fake_async_get(200, captured))
    resp = client.post("/cameras/test-stream", json={"stream_id": "not-yet-registered"}, headers=viewer_headers)
    assert resp.status_code == 200
    assert resp.json() == {"reachable": True}
    assert captured["url"].endswith("/stream/not-yet-registered/index.m3u8")


def test_test_stream_prefers_hls_url_when_both_set(client, viewer_headers, monkeypatch):
    captured = {}
    stream_health_service._cache.clear()
    monkeypatch.setattr(httpx.AsyncClient, "get", _fake_async_get(200, captured))
    resp = client.post(
        "/cameras/test-stream",
        json={"stream_id": "should-be-ignored", "hls_url": "https://elsewhere.example/stream/x/index.m3u8"},
        headers=viewer_headers,
    )
    assert resp.json() == {"reachable": True}
    assert captured["url"] == "https://elsewhere.example/stream/x/index.m3u8"


def test_test_stream_false_on_unreachable_url(client, viewer_headers, monkeypatch):
    stream_health_service._cache.clear()
    monkeypatch.setattr(httpx.AsyncClient, "get", _fake_async_get(404))
    resp = client.post("/cameras/test-stream", json={"stream_id": "dead-stream"}, headers=viewer_headers)
    assert resp.json() == {"reachable": False}
