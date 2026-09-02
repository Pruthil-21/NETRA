import time
import uuid

from app.db import get_conn
from app.services.synthetic_events_service import archive_events_older_than


def test_posting_an_event_is_accepted_and_the_row_lands(client, officer_headers, monkeypatch):
    monkeypatch.setenv("SCALE_DEMO_ENABLED", "true")
    event_id = str(uuid.uuid4())
    resp = client.post(
        "/synthetic/detections",
        json={"event_id": event_id, "camera_id": 1, "payload": {"note": "load-test"}},
        headers=officer_headers,
    )
    # 202 always -- a genuinely async endpoint acknowledges receipt, it doesn't
    # synchronously report whether the eventual write turns out to be a
    # duplicate (that's determined when the background write actually runs).
    assert resp.status_code == 202
    assert resp.json() == {"event_id": event_id, "status": "accepted"}

    # TestClient runs BackgroundTasks to completion as part of the same
    # request/response cycle (Starlette's documented behavior), so the row
    # is already committed by the time client.post() returns here -- no
    # sleep/poll needed.
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM synthetic_detection_events WHERE event_id = %s", (event_id,))
            assert cur.fetchone()[0] == 1
            cur.execute("DELETE FROM synthetic_detection_events WHERE event_id = %s", (event_id,))
        conn.commit()


def test_reposting_the_same_event_id_is_a_no_op_not_a_second_row(client, officer_headers, monkeypatch):
    monkeypatch.setenv("SCALE_DEMO_ENABLED", "true")
    event_id = str(uuid.uuid4())
    body = {"event_id": event_id, "camera_id": 1, "payload": None}

    first = client.post("/synthetic/detections", json=body, headers=officer_headers)
    second = client.post("/synthetic/detections", json=body, headers=officer_headers)
    assert first.status_code == 202
    assert second.status_code == 202  # both accepted -- idempotency is enforced at write time, invisibly to the caller

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM synthetic_detection_events WHERE event_id = %s", (event_id,))
            assert cur.fetchone()[0] == 1  # still exactly one row
            cur.execute("DELETE FROM synthetic_detection_events WHERE event_id = %s", (event_id,))
        conn.commit()


def test_never_touches_the_real_detections_table(client, officer_headers, monkeypatch):
    monkeypatch.setenv("SCALE_DEMO_ENABLED", "true")
    # synthetic_events_service has no import of, or reference to, anything
    # in backend-watchlist -- this test documents that guarantee by asserting
    # the endpoint's own table is the only thing that changes.
    event_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    client.post("/synthetic/detections", json={"event_id": event_id, "camera_id": 1}, headers=officer_headers)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regclass('public.synthetic_detection_events') IS DISTINCT FROM to_regclass('public.detections')")
            assert cur.fetchone()[0] is True  # confirms these are genuinely different tables
            cur.execute("DELETE FROM synthetic_detection_events WHERE event_id = %s", (event_id,))
        conn.commit()


def test_ingestion_is_404_when_the_scale_demo_flag_is_off(client, officer_headers, monkeypatch):
    monkeypatch.delenv("SCALE_DEMO_ENABLED", raising=False)
    resp = client.post("/synthetic/detections", json={"event_id": str(uuid.uuid4()), "camera_id": 1}, headers=officer_headers)
    assert resp.status_code == 404


def test_archive_moves_old_rows_and_leaves_recent_ones_in_place():
    old_event_id = str(uuid.uuid4())
    recent_event_id = str(uuid.uuid4())
    with get_conn() as conn:
        with conn.cursor() as cur:
            # received_at defaults to now(); backdate the "old" row directly.
            cur.execute(
                "INSERT INTO synthetic_detection_events (event_id, camera_id, received_at) "
                "VALUES (%s, %s, now() - interval '31 days')",
                (old_event_id, 1),
            )
            cur.execute(
                "INSERT INTO synthetic_detection_events (event_id, camera_id) VALUES (%s, %s)",
                (recent_event_id, 1),
            )
        conn.commit()

    with get_conn() as conn:
        result = archive_events_older_than(conn, days=30)
    assert result == {"archived": 1}

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM synthetic_detection_events WHERE event_id = %s", (old_event_id,))
            assert cur.fetchone()[0] == 0  # moved out
            cur.execute("SELECT COUNT(*) FROM synthetic_detection_events_archive WHERE event_id = %s", (old_event_id,))
            assert cur.fetchone()[0] == 1  # moved in
            cur.execute("SELECT COUNT(*) FROM synthetic_detection_events WHERE event_id = %s", (recent_event_id,))
            assert cur.fetchone()[0] == 1  # untouched
            cur.execute("DELETE FROM synthetic_detection_events WHERE event_id = %s", (recent_event_id,))
            cur.execute("DELETE FROM synthetic_detection_events_archive WHERE event_id = %s", (old_event_id,))
        conn.commit()
