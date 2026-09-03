"""Idempotent ingestion for synthetic load-test detection events -- a table
and endpoint entirely separate from backend-watchlist's real detections/alerts
pipeline."""
import json


def record_event(conn, event_id: str, camera_id: int, edge_node_id: int | None, payload: dict | None) -> None:
    """ON CONFLICT DO NOTHING is the idempotency guarantee from the event_id
    UNIQUE constraint -- a retried event_id is silently a no-op, never a
    second insert. Called from a BackgroundTask (see main.py), after the
    202 response has already been returned to the caller -- there is
    nothing for this function to report back synchronously."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO synthetic_detection_events (event_id, camera_id, edge_node_id, payload)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (event_id) DO NOTHING
            """,
            (event_id, camera_id, edge_node_id, json.dumps(payload) if payload is not None else None),
        )
    conn.commit()


def archive_events_older_than(conn, days: int) -> dict:
    """Moves rows older than `days` into synthetic_detection_events_archive
    (same shape, via Task 1's `LIKE ... INCLUDING ALL`) and removes them from
    the live table -- one transaction, so a row is never counted in neither
    or both tables at once. Never touches anything outside these two tables."""
    with conn.cursor() as cur:
        cur.execute(
            """
            WITH moved AS (
                DELETE FROM synthetic_detection_events
                WHERE received_at < now() - (%s || ' days')::interval
                RETURNING id, event_id, camera_id, edge_node_id, payload, received_at
            )
            INSERT INTO synthetic_detection_events_archive
                (id, event_id, camera_id, edge_node_id, payload, received_at)
            SELECT id, event_id, camera_id, edge_node_id, payload, received_at FROM moved
            """,
            (days,),
        )
        archived = cur.rowcount
    conn.commit()
    return {"archived": archived}
