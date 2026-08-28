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
    }


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
