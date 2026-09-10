import uuid

from app.db import get_conn


def _cleanup(event_id):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM recording_health_events WHERE event_id = %s", (event_id,))
        conn.commit()


def test_missing_webhook_key_header_is_rejected(client, monkeypatch):
    monkeypatch.setenv("RECORDING_WEBHOOK_KEY", "test-webhook-key")
    resp = client.post(
        "/recordings/health-events",
        json={"event_id": str(uuid.uuid4()), "path": "7", "status": "recording"},
    )
    assert resp.status_code == 401


def test_wrong_webhook_key_is_rejected(client, monkeypatch):
    monkeypatch.setenv("RECORDING_WEBHOOK_KEY", "test-webhook-key")
    resp = client.post(
        "/recordings/health-events",
        json={"event_id": str(uuid.uuid4()), "path": "7", "status": "recording"},
        headers={"X-Webhook-Key": "wrong-key"},
    )
    assert resp.status_code == 401


def test_unset_webhook_key_rejects_every_call(client, monkeypatch):
    monkeypatch.delenv("RECORDING_WEBHOOK_KEY", raising=False)
    resp = client.post(
        "/recordings/health-events",
        json={"event_id": str(uuid.uuid4()), "path": "7", "status": "recording"},
        headers={"X-Webhook-Key": ""},
    )
    assert resp.status_code == 401


def test_valid_event_is_accepted_and_the_row_lands(client, monkeypatch):
    monkeypatch.setenv("RECORDING_WEBHOOK_KEY", "test-webhook-key")
    event_id = str(uuid.uuid4())
    resp = client.post(
        "/recordings/health-events",
        json={
            "event_id": event_id, "path": "7", "status": "recording",
            "message": "segment uploaded", "occurred_at": "2026-09-08T10:00:00Z",
            "payload": {"segment_seconds": 60},
        },
        headers={"X-Webhook-Key": "test-webhook-key"},
    )
    # 202 always -- a genuinely async endpoint acknowledges receipt, it
    # doesn't synchronously report whether the eventual write turns out to
    # be a duplicate (that's determined when the background write runs).
    assert resp.status_code == 202
    assert resp.json() == {"event_id": event_id, "status": "accepted"}

    # TestClient runs BackgroundTasks to completion as part of the same
    # request/response cycle, so the row is already committed here -- no
    # sleep/poll needed (see test_synthetic_events.py for the same idiom).
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT stream_id, status, message FROM recording_health_events WHERE event_id = %s", (event_id,)
            )
            row = cur.fetchone()
            assert row == ("7", "recording", "segment uploaded")
    _cleanup(event_id)


def test_health_events_snapshot_returns_recent_events_for_the_camera(client, officer_headers, monkeypatch, gap_analysis_test_cameras):
    monkeypatch.setenv("RECORDING_WEBHOOK_KEY", "test-webhook-key")
    stream_id = f"snap-{uuid.uuid4().hex[:8]}"
    created = client.post(
        "/cameras",
        json={
            "name": "Health Snapshot Camera", "dept": "Traffic Police", "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
            "stream_id": stream_id,
        },
        headers=officer_headers,
    ).json()
    gap_analysis_test_cameras.append(created["id"])

    event_id = str(uuid.uuid4())
    resp = client.post(
        "/recordings/health-events",
        json={"event_id": event_id, "path": stream_id, "status": "recording", "message": "seg uploaded"},
        headers={"X-Webhook-Key": "test-webhook-key"},
    )
    assert resp.status_code == 202

    snapshot = client.get(f"/cameras/{created['id']}/recordings/health-events", headers=officer_headers)
    assert snapshot.status_code == 200
    events = snapshot.json()
    assert len(events) == 1
    assert events[0]["event_id"] == event_id
    assert events[0]["status"] == "recording"
    assert events[0]["message"] == "seg uploaded"

    _cleanup(event_id)


def test_health_events_snapshot_requires_camera_in_scope(client, officer_headers, gap_analysis_test_cameras):
    created = client.post(
        "/cameras",
        json={
            "name": "Snapshot Scope Camera", "dept": "Anand", "lat": 23.0, "long": 72.5,
            "camera_type": "IP", "ownership": "test", "storage_type": "Cloud", "retention_days": 30,
            "stream_id": "snap-scope",
        },
        headers=officer_headers,
    ).json()
    gap_analysis_test_cameras.append(created["id"])

    import jwt as pyjwt
    from app.config import settings

    token = pyjwt.encode(
        {"sub": "1", "badge_number": "GJ-station_officer", "role": "station_officer",
         "scope_type": "district", "scope_value": "Ahmedabad", "permissions": ["view_live_feeds"]},
        settings.jwt_secret, algorithm="HS256",
    )
    resp = client.get(f"/cameras/{created['id']}/recordings/health-events", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403


def test_reposting_the_same_event_id_is_a_no_op_not_a_second_row(client, monkeypatch):
    monkeypatch.setenv("RECORDING_WEBHOOK_KEY", "test-webhook-key")
    event_id = str(uuid.uuid4())
    body = {"event_id": event_id, "path": "7", "status": "recording"}
    headers = {"X-Webhook-Key": "test-webhook-key"}

    first = client.post("/recordings/health-events", json=body, headers=headers)
    second = client.post("/recordings/health-events", json=body, headers=headers)
    assert first.status_code == 202
    assert second.status_code == 202  # both accepted -- idempotency is enforced at write time, invisibly to the caller

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM recording_health_events WHERE event_id = %s", (event_id,))
            assert cur.fetchone()[0] == 1  # still exactly one row
    _cleanup(event_id)
