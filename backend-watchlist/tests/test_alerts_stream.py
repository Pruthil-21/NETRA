import concurrent.futures
import contextlib
import json
import uuid

import anyio
import jwt
import psycopg2
import psycopg2.extras
import pytest
from app.config import settings
from starlette.websockets import WebSocketDisconnect

# WebSocketTestSession.receive()/receive_json()/receive_text() in this
# Starlette version (1.6.0) are unbounded, timeout-less blocking calls:
# `self.portal.call(self._send_rx.receive)` waits forever for a message.
# If a broadcast never arrives -- a scoping bug, a re-broken datetime
# serialization, a loop-capture failure -- the test hangs indefinitely
# instead of failing. A hung pytest process then has to be killed
# out-of-band, which bypasses normal fixture teardown and leaks whatever a
# fixture's guaranteed-cleanup-on-exception path would otherwise have
# removed (see scoping_test_cameras, and the leaked
# "Alerts Stream Test Cam (WS Scoping Test District A)" rows this exact
# hang produced before the datetime-serialization fix). Every blocking
# receive in this file goes through this bounded helper instead, so a
# broken broadcast fails the test cleanly.
_WS_RECEIVE_TIMEOUT = 5.0


def _receive_json_with_timeout(ws, timeout: float = _WS_RECEIVE_TIMEOUT):
    """Bounded stand-in for WebSocketTestSession.receive_json().

    Uses the portal task's own concurrent.futures.Future timeout (rather
    than portal.call(), which has none) so a missing broadcast raises a
    clean test failure instead of hanging the process forever.
    """
    future = ws.portal.start_task_soon(ws._send_rx.receive)
    try:
        message = future.result(timeout=timeout)
    except concurrent.futures.TimeoutError:
        future.cancel()
        pytest.fail(
            f"Timed out after {timeout}s waiting for a WebSocket message "
            "-- the expected broadcast never arrived (see module docstring "
            "comment on _WS_RECEIVE_TIMEOUT for why this is bounded)."
        )
    ws._raise_on_close(message)
    return json.loads(message["text"])


def _rbac_token(role, scope_type, scope_value=None):
    return jwt.encode(
        {"sub": "1", "badge_number": "WS-TEST", "role": role, "scope_type": scope_type,
         "scope_value": scope_value, "permissions": []},
        settings.jwt_secret, algorithm="HS256",
    )


def _random_plate_for_stream_test():
    return f"GJ01WS{uuid.uuid4().hex[:4].upper()}"


def _insert_test_camera(dept: str) -> int:
    """Creates a real, isolated camera row in a controlled department --
    matching test_detections.py's _insert_test_camera pattern. Necessary
    because this environment's actual seeded cameras table holds real Gujarat
    camera data (dept values like "Ahmedabad", "Junagadh"), not the small
    demo seed.sql's "Traffic Police"/"Municipal Corp" values -- a
    district-scoping test can't assume any particular existing camera id's
    dept, it has to control it."""
    with contextlib.closing(psycopg2.connect(settings.database_url)) as conn, \
            conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days)
            VALUES (%s, %s, ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'fixed', 'govt', 'cloud', 30)
            RETURNING id
            """,
            (f"Alerts Stream Test Cam ({dept})", dept),
        )
        camera_id = cur.fetchone()["id"]
        conn.commit()
    return camera_id


def test_invalid_token_closes_connection(client):
    # This Starlette version raises WebSocketDisconnect from __enter__ itself
    # when the ASGI app closes the connection before ever accepting it (no
    # partial handshake) -- so the whole `with` statement, not just a
    # receive/send call inside it, is what raises.
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect("/alerts/stream?token=not-a-real-token"):
            pass
    assert exc_info.value.code == 4401


def test_district_scoped_connection_receives_matching_district_alert(
    client, officer_headers, internal_headers, scoping_test_cameras
):
    camera_id = _insert_test_camera("WS Scoping Test District A")
    scoping_test_cameras.append(camera_id)

    token = _rbac_token("district_command", "district", "WS Scoping Test District A")
    with client.websocket_connect(f"/alerts/stream?token={token}") as ws:
        plate = _random_plate_for_stream_test()
        watchlist_resp = client.post(
            "/watchlist",
            json={"plate_number": plate, "reason": "stream test", "dept_flagged": "WS Scoping Test District A"},
            headers=officer_headers,
        )
        assert watchlist_resp.status_code == 201
        detect_resp = client.post(
            "/detections", json={"camera_id": camera_id, "plate_number": plate}, headers=internal_headers
        )
        assert detect_resp.status_code == 201

        message = _receive_json_with_timeout(ws)
        assert message["plate_number"] == plate


def test_non_matching_district_connection_does_not_receive_alert(
    client, officer_headers, internal_headers, scoping_test_cameras
):
    # A connection scoped to a district other than the alert's camera's dept
    # must never see the broadcast -- proving the WS is genuinely
    # district-scoped, not just "receives everything and the test happens to
    # only check the positive case." A blocking receive_text()/receive_json()
    # can't prove a negative without an arbitrary sleep/timeout (flaky either
    # way), so this checks the manager's internal per-connection queue via
    # receive_nowait() instead of blocking -- see below for why that's race-free.
    camera_id = _insert_test_camera("WS Scoping Test District B")
    scoping_test_cameras.append(camera_id)

    other_token = _rbac_token("district_command", "district", "WS Scoping Test District Elsewhere")
    match_token = _rbac_token("district_command", "district", "WS Scoping Test District B")

    # Connection order matters for the race-freedom argument below: ws_other
    # must be registered (and therefore iterated over) in
    # AlertsConnectionManager._broadcast_async's for-loop *before* ws_match.
    with client.websocket_connect(f"/alerts/stream?token={other_token}") as ws_other, \
            client.websocket_connect(f"/alerts/stream?token={match_token}") as ws_match:
        plate = _random_plate_for_stream_test()
        watchlist_resp = client.post(
            "/watchlist",
            json={"plate_number": plate, "reason": "stream test", "dept_flagged": "WS Scoping Test District B"},
            headers=officer_headers,
        )
        assert watchlist_resp.status_code == 201
        detect_resp = client.post(
            "/detections", json={"camera_id": camera_id, "plate_number": plate}, headers=internal_headers
        )
        assert detect_resp.status_code == 201

        # Blocks until the single _broadcast_async() call for this alert has
        # sent to ws_match. Because dict iteration order is insertion order,
        # ws_other (connected first, above) was already visited -- and, since
        # it doesn't match, skipped with no `await` -- earlier in that same
        # coroutine's synchronous for-loop body, strictly before ws_match's
        # `await send_json` was even reached. So by the time this returns,
        # ws_other's fate for this alert is already decided; no message was
        # ever, or will ever be, queued for it.
        message = _receive_json_with_timeout(ws_match)
        assert message["plate_number"] == plate

        with pytest.raises(anyio.WouldBlock):
            ws_other.portal.call(ws_other._send_rx.receive_nowait)


def test_platform_scoped_connection_receives_any_district_alert(
    client, officer_headers, internal_headers, scoping_test_cameras
):
    camera_id = _insert_test_camera("WS Scoping Test District C")
    scoping_test_cameras.append(camera_id)

    token = _rbac_token("super_admin", "platform")
    with client.websocket_connect(f"/alerts/stream?token={token}") as ws:
        plate = _random_plate_for_stream_test()
        watchlist_resp = client.post(
            "/watchlist",
            json={"plate_number": plate, "reason": "stream test", "dept_flagged": "WS Scoping Test District C"},
            headers=officer_headers,
        )
        assert watchlist_resp.status_code == 201
        detect_resp = client.post(
            "/detections", json={"camera_id": camera_id, "plate_number": plate}, headers=internal_headers
        )
        assert detect_resp.status_code == 201

        message = _receive_json_with_timeout(ws)
        assert message["plate_number"] == plate
