"""Aggregate stats for the gap-analysis report — pulls numbers a teammate
would otherwise count by hand for the pitch deck."""
import psycopg


def get_summary(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT dept, COUNT(*) FROM cameras GROUP BY dept")
        by_department = dict(cur.fetchall())

        cur.execute("SELECT connectivity_status, COUNT(*) FROM cameras GROUP BY connectivity_status")
        by_connectivity = dict(cur.fetchall())

        cur.execute("SELECT health_status, COUNT(*) FROM cameras GROUP BY health_status")
        by_health = dict(cur.fetchall())

        cur.execute("SELECT COUNT(*) FROM cameras")
        total_cameras = cur.fetchone()[0]

    return {
        "total_cameras": total_cameras,
        "cameras_by_department": by_department,
        "cameras_by_connectivity_status": by_connectivity,
        "cameras_by_health_status": by_health,
        "alerts_last_24h": _count_last_24h(conn, "alerts", "matched_at"),
        "detections_last_24h": _count_last_24h(conn, "detections", "detected_at"),
        "blacklist_entries_last_24h": _count_last_24h(conn, "watchlist", "date_added"),
        "avg_alert_response_seconds": _avg_alert_response_seconds(conn),
    }


def _avg_alert_response_seconds(conn):
    """Average time between an alert firing (alerts.matched_at) and the
    first status change away from 'NEW' (alert_status_history's earliest
    row for that alert) -- how fast officers actually respond. None if
    backend-watchlist's schema hasn't been applied yet, or no alert has
    ever been acknowledged."""
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT AVG(EXTRACT(EPOCH FROM (first_response.changed_at - a.matched_at)))
                FROM alerts a
                JOIN LATERAL (
                    SELECT changed_at FROM alert_status_history
                    WHERE alert_id = a.id AND status != 'NEW'
                    ORDER BY changed_at ASC
                    LIMIT 1
                ) first_response ON true
            """)
            result = cur.fetchone()[0]
            return float(result) if result is not None else None
    except psycopg.Error:
        conn.rollback()
        return None


def _count_last_24h(conn, table: str, ts_column: str):
    """alerts/detections are owned by backend-watchlist's schema.sql but live
    in the same physical Postgres instance (same convention as audit_logs) —
    read directly rather than adding an HTTP hop just for a report number.
    Returns None if that schema hasn't been applied yet in this environment,
    instead of failing the whole summary.
    """
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT COUNT(*) FROM {table} WHERE {ts_column} >= now() - interval '24 hours'"
            )
            return cur.fetchone()[0]
    except psycopg.Error:
        conn.rollback()
        return None
