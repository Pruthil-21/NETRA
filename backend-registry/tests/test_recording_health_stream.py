import concurrent.futures
import json
import uuid

import jwt
import pytest
from app.config import settings
from starlette.websockets import WebSocketDisconnect

# Same reasoning as backend-watchlist's tests/test_alerts_stream.py: this
# Starlette version's WebSocketTestSession.receive_*() calls are unbounded,
# timeout-less blocking calls. A scoping bug or a broken loop capture would
# hang the test forever instead of failing cleanly, so every blocking
# receive here goes through this bounded helper instead.
_WS_RECEIVE_TIMEOUT = 5.0


def _receive_json_with_timeout(ws, timeout: float = _WS_RECEIVE_TIMEOUT):
    future = ws.portal.start_task_soon(ws._send_rx.receive)
    try:
        message = future.result(timeout=timeout)
    except concurrent.futures.TimeoutError:
        future.cancel()
        pytest.fail(f"Timed out after {timeout}s waiting for a WebSocket message -- the expected broadcast never arrived.")
    ws._raise_on_close(message)
    return json.loads(message["text"])


def _rbac_token(role, scope_type, scope_value=None):
    return jwt.encode(
        {"sub": "1", "badge_number": "WS-TEST", "role": role, "scope_type": scope_type,
         "scope_value": scope_value, "permissions": []},
        settings.jwt_secret, algorithm="HS256",
    )


def _post_health_event(client, path, status="recording", event_id=None):
    return client.post(
        "/recordings/health-events",
        json={"event_id": event_id or str(uuid.uuid4()), "path": path, "status": status},
        headers={"X-Webhook-Key": "test-webhook-key"},
    )


def _create_camera(client, officer_headers, dept, stream_id):
    created = client.post(
        "/cameras",
        json={
            "name": f"WS Health Test Cam ({dept})", "dept": dept, "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
            "stream_id": stream_id,
        },
        headers=officer_headers,
    ).json()
    return created["id"]


def test_invalid_token_closes_connection(client):
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect("/recordings/health-stream?token=not-a-real-token"):
            pass
    assert exc_info.value.code == 4401


def test_viewer_role_rejected_at_connect(client):
    token = jwt.encode(
        {"sub": "1", "role": "viewer", "scope_type": "platform"}, settings.jwt_secret, algorithm="HS256"
    )
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect(f"/recordings/health-stream?token={token}"):
            pass
    assert exc_info.value.code == 4403


def test_district_scoped_connection_receives_matching_district_event(
    client, officer_headers, monkeypatch, gap_analysis_test_cameras
):
    monkeypatch.setenv("RECORDING_WEBHOOK_KEY", "test-webhook-key")
    stream_id = f"ws-{uuid.uuid4().hex[:8]}"
    camera_id = _create_camera(client, officer_headers, "WS Health Test District A", stream_id)
    gap_analysis_test_cameras.append(camera_id)

    token = _rbac_token("district_command", "district", "WS Health Test District A")
    with client.websocket_connect(f"/recordings/health-stream?token={token}") as ws:
        resp = _post_health_event(client, stream_id)
        assert resp.status_code == 202

        message = _receive_json_with_timeout(ws)
        assert message["camera_id"] == camera_id
        assert message["stream_id"] == stream_id
        assert message["status"] == "recording"


def test_non_matching_district_connection_does_not_receive_event(
    client, officer_headers, monkeypatch, gap_analysis_test_cameras
):
    monkeypatch.setenv("RECORDING_WEBHOOK_KEY", "test-webhook-key")
    stream_id = f"ws-{uuid.uuid4().hex[:8]}"
    camera_id = _create_camera(client, officer_headers, "WS Health Test District B", stream_id)
    gap_analysis_test_cameras.append(camera_id)

    other_token = _rbac_token("district_command", "district", "WS Health Test District Elsewhere")
    match_token = _rbac_token("district_command", "district", "WS Health Test District B")

    # Connection order matters here, same as the alerts_stream precedent:
    # ws_other must be registered (and iterated) before ws_match so its
    # non-match is already decided by the time ws_match's receive returns.
    with client.websocket_connect(f"/recordings/health-stream?token={other_token}") as ws_other, \
            client.websocket_connect(f"/recordings/health-stream?token={match_token}") as ws_match:
        resp = _post_health_event(client, stream_id)
        assert resp.status_code == 202

        message = _receive_json_with_timeout(ws_match)
        assert message["camera_id"] == camera_id

        import anyio
        with pytest.raises(anyio.WouldBlock):
            ws_other.portal.call(ws_other._send_rx.receive_nowait)


def test_platform_scoped_connection_receives_any_district_event(
    client, officer_headers, monkeypatch, gap_analysis_test_cameras
):
    monkeypatch.setenv("RECORDING_WEBHOOK_KEY", "test-webhook-key")
    stream_id = f"ws-{uuid.uuid4().hex[:8]}"
    camera_id = _create_camera(client, officer_headers, "WS Health Test District C", stream_id)
    gap_analysis_test_cameras.append(camera_id)

    token = _rbac_token("super_admin", "platform")
    with client.websocket_connect(f"/recordings/health-stream?token={token}") as ws:
        resp = _post_health_event(client, stream_id)
        assert resp.status_code == 202

        message = _receive_json_with_timeout(ws)
        assert message["camera_id"] == camera_id
