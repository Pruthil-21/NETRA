"""Persists inbound recording-health events from the DIGDHRISHTI
continuous-recording service (streaming/recording -- Dhruv's project; see
routers/recording_webhooks.py). ON CONFLICT DO NOTHING on event_id is the
idempotency guarantee the recorder's own retry-on-failure behavior needs --
a retried event_id is silently a no-op, never a duplicate row. Same pattern
as synthetic_events_service.record_event."""
import json


def record_event(
    conn,
    event_id: str,
    stream_id: str,
    status: str,
    message: str | None,
    occurred_at: str | None,
    payload: dict | None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO recording_health_events (event_id, stream_id, status, message, occurred_at, payload)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (event_id) DO NOTHING
            """,
            (event_id, stream_id, status, message, occurred_at, json.dumps(payload) if payload is not None else None),
        )
    conn.commit()


def list_recent(conn, stream_id: str, limit: int = 20) -> list[dict]:
    """Backs the live health surface's initial snapshot -- a local, indexed
    query against our own table, not a call out to the recording service
    (see recordings_service.recording_health for that). Newest first: an
    officer checking a camera's recording status wants "what just happened,"
    not the full history from the start."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT event_id, stream_id, status, message, occurred_at, received_at
            FROM recording_health_events
            WHERE stream_id = %s
            ORDER BY received_at DESC
            LIMIT %s
            """,
            (str(stream_id), limit),
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]
