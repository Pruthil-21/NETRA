"""cameras_service's connectivity sweep -- the single server-owned writer of
connectivity_status now, replacing every officer's browser independently
re-probing every camera's stream (see the camera-badge-accuracy fix).

Exercises _probe_camera (URL resolution) and _apply_probe_results (the
debounce/write logic) directly, NOT the full sweep_connectivity_once/
list_cameras_page path -- this is a shared dev database with many real
camera rows from other features/seed scripts, and sweep_connectivity_once
pages and probes every one of them. Calling it directly in a test would mean
a monkeypatched check_hls_reachable result gets applied to every real camera
in the whole table, not just a test-created one -- these two functions carry
the actual debounce/write logic under test and let a test target only the
camera(s) it created."""
import asyncio

import httpx
from app.db import get_conn
from app.services import cameras_service


def _create_camera(client, officer_headers, gap_analysis_test_cameras, **overrides) -> dict:
    body = {
        "name": "Sweep Test Camera", "dept": "Traffic Police", "lat": 23.0, "long": 72.5,
        "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
        "stream_id": "sweep-test-cam",
        **overrides,
    }
    created = client.post("/cameras", json=body, headers=officer_headers).json()
    gap_analysis_test_cameras.append(created["id"])
    return created


def _get_status(camera_id: int) -> str:
    with get_conn() as conn:
        camera = cameras_service.get_camera(conn, camera_id)
    return camera["connectivity_status"]


def _history_count(camera_id: int) -> int:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM camera_status_history WHERE camera_id = %s", (camera_id,))
        return cur.fetchone()[0]


def _apply(camera_id: int, reachable: bool, current_status: str) -> None:
    asyncio.run(cameras_service._apply_probe_results([(camera_id, reachable)], {camera_id: current_status}))


def test_camera_flips_online_on_first_successful_probe(client, officer_headers, gap_analysis_test_cameras):
    cam = _create_camera(client, officer_headers, gap_analysis_test_cameras)
    cameras_service._consecutive_failures.clear()

    _apply(cam["id"], True, "unknown")

    assert _get_status(cam["id"]) == "online"


def test_camera_stays_online_after_a_single_missed_probe(client, officer_headers, gap_analysis_test_cameras):
    """The whole point of the debounce -- one bad tick must not flip the
    sitewide badge."""
    cam = _create_camera(client, officer_headers, gap_analysis_test_cameras)
    cameras_service._consecutive_failures.clear()
    _apply(cam["id"], True, "unknown")
    assert _get_status(cam["id"]) == "online"

    _apply(cam["id"], False, "online")

    assert _get_status(cam["id"]) == "online", "a single missed probe must not flip the badge"


def test_camera_flips_offline_only_after_consecutive_failure_threshold(
    client, officer_headers, gap_analysis_test_cameras
):
    cam = _create_camera(client, officer_headers, gap_analysis_test_cameras)
    cameras_service._consecutive_failures.clear()
    _apply(cam["id"], True, "unknown")
    assert _get_status(cam["id"]) == "online"

    for _ in range(cameras_service._OFFLINE_AFTER_CONSECUTIVE_FAILURES - 1):
        _apply(cam["id"], False, _get_status(cam["id"]))
        assert _get_status(cam["id"]) == "online", "still within the debounce window"

    _apply(cam["id"], False, _get_status(cam["id"]))
    assert _get_status(cam["id"]) == "offline"


def test_camera_recovers_immediately_on_the_next_successful_probe(
    client, officer_headers, gap_analysis_test_cameras
):
    cam = _create_camera(client, officer_headers, gap_analysis_test_cameras)
    cameras_service._consecutive_failures.clear()
    for _ in range(cameras_service._OFFLINE_AFTER_CONSECUTIVE_FAILURES):
        _apply(cam["id"], False, _get_status(cam["id"]))
    assert _get_status(cam["id"]) == "offline"

    _apply(cam["id"], True, "offline")

    assert _get_status(cam["id"]) == "online", "recovery is immediate, not debounced"


def test_only_real_transitions_write_camera_status_history(client, officer_headers, gap_analysis_test_cameras):
    cam = _create_camera(client, officer_headers, gap_analysis_test_cameras)
    cameras_service._consecutive_failures.clear()

    _apply(cam["id"], True, "unknown")
    _apply(cam["id"], True, "online")
    _apply(cam["id"], True, "online")

    assert _get_status(cam["id"]) == "online"
    assert _history_count(cam["id"]) == 1, "repeated successful probes with no status change must not spam history"


def test_a_failed_probe_that_never_crosses_the_threshold_writes_no_history(
    client, officer_headers, gap_analysis_test_cameras
):
    cam = _create_camera(client, officer_headers, gap_analysis_test_cameras)
    cameras_service._consecutive_failures.clear()
    _apply(cam["id"], True, "unknown")
    assert _history_count(cam["id"]) == 1

    _apply(cam["id"], False, "online")

    assert _history_count(cam["id"]) == 1, "still within the debounce window -- nothing changed yet"


async def _resolve_probe(camera: dict) -> tuple[int, bool]:
    sem = asyncio.Semaphore(1)
    async with httpx.AsyncClient() as http_client:
        return await cameras_service._probe_camera(http_client, sem, camera)


def test_probe_camera_reports_unreachable_when_no_stream_url_is_configured():
    camera = {"id": 999999, "hls_url": None, "stream_id": None}

    camera_id, reachable = asyncio.run(_resolve_probe(camera))

    assert camera_id == 999999
    assert reachable is False


def test_probe_camera_uses_check_hls_reachable_for_a_resolvable_url(monkeypatch):
    captured = {}

    async def fake_check(client, url):
        captured["url"] = url
        return True

    monkeypatch.setattr(cameras_service.stream_health_service, "check_hls_reachable", fake_check)
    camera = {"id": 42, "hls_url": "https://elsewhere.example/stream/x/index.m3u8", "stream_id": None}

    camera_id, reachable = asyncio.run(_resolve_probe(camera))

    assert camera_id == 42
    assert reachable is True
    assert captured["url"] == "https://elsewhere.example/stream/x/index.m3u8"


def test_a_real_network_error_counts_as_a_failed_probe_not_a_crash(monkeypatch):
    """check_hls_reachable already swallows httpx errors into False (see its
    own try/except); this confirms _probe_camera's call path preserves that
    rather than letting the exception propagate and kill the whole sweep."""
    cameras_service.stream_health_service._cache.clear()

    async def fake_get(self, url, timeout=None, follow_redirects=None):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    camera = {"id": 7, "hls_url": "https://unreachable.example/stream/x/index.m3u8", "stream_id": None}

    camera_id, reachable = asyncio.run(_resolve_probe(camera))

    assert camera_id == 7
    assert reachable is False
