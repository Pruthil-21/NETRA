"""Gap-analysis report computations: uncovered zones (coverage targets
farther than a threshold from the nearest camera) and ageing infrastructure
(old cameras with a history of connectivity problems)."""


def compute_uncovered_zones(conn, threshold_m: int = 100) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                t.id, t.name, t.district,
                nearest.camera_id, nearest.distance_meters
            FROM coverage_targets t
            LEFT JOIN LATERAL (
                SELECT c.id AS camera_id, ST_Distance(t.location, c.location) AS distance_meters
                FROM cameras c
                ORDER BY t.location <-> c.location
                LIMIT 1
            ) nearest ON true
            ORDER BY t.id
            """
        )
        rows = cur.fetchall()

    zones = []
    for target_id, name, district, camera_id, distance_meters in rows:
        if camera_id is None or distance_meters > threshold_m:
            zones.append({
                "target_id": target_id,
                "name": name,
                "district": district,
                "nearest_camera_id": camera_id,
                "distance_meters": distance_meters,
            })
    return zones


def compute_ageing_infrastructure(conn, age_threshold_days: int = 1095) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                c.id, c.name, c.dept,
                EXTRACT(DAY FROM now() - c.created_at)::int AS age_days,
                COUNT(h.id) FILTER (
                    WHERE h.connectivity_status IN ('offline', 'degraded')
                    AND h.changed_at > now() - interval '90 days'
                ) AS degraded_transition_count_90d
            FROM cameras c
            LEFT JOIN camera_status_history h ON h.camera_id = c.id
            WHERE c.created_at < now() - (%s || ' days')::interval
            GROUP BY c.id, c.name, c.dept, c.created_at
            ORDER BY degraded_transition_count_90d DESC, age_days DESC
            """,
            (age_threshold_days,),
        )
        rows = cur.fetchall()

    return [
        {
            "camera_id": camera_id,
            "name": name,
            "district": district,
            "age_days": age_days,
            "degraded_transition_count_90d": degraded_count,
        }
        for camera_id, name, district, age_days, degraded_count in rows
    ]
