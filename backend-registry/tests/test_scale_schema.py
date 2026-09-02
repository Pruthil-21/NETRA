import uuid

import pytest

from app.db import get_conn


def test_cameras_is_synthetic_defaults_false_for_existing_rows(synthetic_test_cameras):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO cameras (name, dept, location, camera_type, ownership,
                    connectivity_status, storage_type, retention_days, health_status)
                VALUES ('Schema Test Camera', 'Traffic Police',
                    ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'ip', 'traffic-police',
                    'online', 'nvr', 15, 'operational')
                RETURNING id, is_synthetic
            """)
            row = cur.fetchone()
            synthetic_test_cameras.append(row[0])
            conn.commit()
    assert row[1] is False


def test_edge_nodes_table_exists_and_accepts_a_row(synthetic_test_edge_nodes):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO edge_nodes (name, district, is_synthetic) VALUES (%s, %s, %s) RETURNING id",
                ("Schema Test Edge Node", "Test District", True),
            )
            row = cur.fetchone()
            synthetic_test_edge_nodes.append(row[0])
            conn.commit()
    assert row[0] is not None


def test_synthetic_detection_events_event_id_is_unique():
    event_id = uuid.uuid4()
    with get_conn() as conn:
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO synthetic_detection_events (event_id, camera_id) VALUES (%s, %s)",
                    (event_id, 1),
                )
                conn.commit()
                with pytest.raises(Exception):
                    cur.execute(
                        "INSERT INTO synthetic_detection_events (event_id, camera_id) VALUES (%s, %s)",
                        (event_id, 1),
                    )
                conn.rollback()
        finally:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM synthetic_detection_events WHERE event_id = %s",
                    (event_id,),
                )
                conn.commit()
