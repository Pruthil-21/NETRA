from app.db import get_conn
from app.services import audit_service


def _fetch(conn, log_id):
    with conn.cursor() as cur:
        cur.execute("SELECT user_id, badge_number FROM audit_logs WHERE id = %s", (log_id,))
        return cur.fetchone()


def test_badge_number_defaults_to_user_id_when_not_given():
    """Almost every real call site passes only user_id (already a badge
    number string) and never the separate badge_number= kwarg -- which is
    what the actor-name enrichment join in audit_logs_service.list_logs
    actually keys on. Without this default, "who did this" silently stays
    blank for most rows."""
    with get_conn() as conn:
        try:
            audit_service.log(conn, "GJ-1042", "test_action", "test_resource")
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id FROM audit_logs WHERE action = 'test_action' AND resource_type = 'test_resource'"
                )
                new_id = cur.fetchone()[0]
            user_id, badge_number = _fetch(conn, new_id)
            assert user_id == "GJ-1042"
            assert badge_number == "GJ-1042"
        finally:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM audit_logs WHERE action = 'test_action' AND resource_type = 'test_resource'")
            conn.commit()


def test_explicit_badge_number_is_not_overridden():
    with get_conn() as conn:
        try:
            audit_service.log(conn, "ml-anpr", "test_action_explicit", "test_resource", badge_number="GJ-9999")
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT user_id, badge_number FROM audit_logs "
                    "WHERE action = 'test_action_explicit' AND resource_type = 'test_resource'"
                )
                user_id, badge_number = cur.fetchone()
            assert user_id == "ml-anpr"
            assert badge_number == "GJ-9999"
        finally:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM audit_logs WHERE action = 'test_action_explicit' AND resource_type = 'test_resource'"
                )
            conn.commit()
