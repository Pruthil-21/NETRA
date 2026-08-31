"""Business logic for cameras — raw SQL via psycopg, no ORM."""


def list_cameras(conn):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, dept, ST_Y(location::geometry) AS lat,
                   ST_X(location::geometry) AS long, camera_type, ownership,
                   connectivity_status, storage_type, retention_days,
                   health_status, rtsp_url, stream_id, hls_url
            FROM cameras
            ORDER BY id
        """)
        cols = [c.name for c in cur.description]
        rows = cur.fetchall()
        return [dict(zip(cols, row)) for row in rows]


def get_camera(conn, camera_id: int):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, dept, ST_Y(location::geometry) AS lat,
                   ST_X(location::geometry) AS long, camera_type, ownership,
                   connectivity_status, storage_type, retention_days,
                   health_status, rtsp_url, stream_id, hls_url
            FROM cameras
            WHERE id = %s
        """, (camera_id,))
        row = cur.fetchone()
        if row is None:
            return None
        cols = [c.name for c in cur.description]
        return dict(zip(cols, row))


def create_camera(conn, data: dict):
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO cameras (
                name, dept, location, camera_type, ownership,
                connectivity_status, storage_type, retention_days,
                health_status, rtsp_url, stream_id, hls_url
            )
            VALUES (
                %(name)s, %(dept)s,
                ST_SetSRID(ST_MakePoint(%(long)s, %(lat)s), 4326),
                %(camera_type)s, %(ownership)s, %(connectivity_status)s,
                %(storage_type)s, %(retention_days)s, %(health_status)s,
                %(rtsp_url)s, %(stream_id)s, %(hls_url)s
            )
            RETURNING id
        """, {**data, "stream_id": data.get("stream_id"), "hls_url": data.get("hls_url")})
        new_id = cur.fetchone()[0]
        conn.commit()
    return get_camera(conn, new_id)


def update_camera(conn, camera_id: int, data: dict):
    """Returns (updated_camera, connectivity_changed: bool) -- the router
    uses connectivity_changed to decide whether to also write an audit_logs
    entry (skipped for connectivity-only changes; camera_status_history
    covers that case instead)."""
    fields = {k: v for k, v in data.items() if v is not None}
    if not fields:
        return get_camera(conn, camera_id), False

    connectivity_changed = False
    with conn.cursor() as cur:
        if "connectivity_status" in fields:
            cur.execute("SELECT connectivity_status FROM cameras WHERE id = %s", (camera_id,))
            row = cur.fetchone()
            if row is None:
                return None, False
            current_status = row[0]
            if fields["connectivity_status"] != current_status:
                connectivity_changed = True

        set_clauses = [f"{key} = %({key})s" for key in fields if key not in ("lat", "long")]
        if "lat" in fields and "long" in fields:
            set_clauses.append("location = ST_SetSRID(ST_MakePoint(%(long)s, %(lat)s), 4326)")

        cur.execute(f"""
            UPDATE cameras SET {', '.join(set_clauses)}
            WHERE id = %(camera_id)s
            RETURNING id
        """, {**fields, "camera_id": camera_id})
        row = cur.fetchone()
        if row is None:
            conn.commit()
            return None, False

        if connectivity_changed:
            cur.execute(
                "INSERT INTO camera_status_history (camera_id, connectivity_status) VALUES (%s, %s)",
                (camera_id, fields["connectivity_status"]),
            )
        conn.commit()

    return get_camera(conn, camera_id), connectivity_changed


def delete_camera(conn, camera_id: int) -> bool:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM cameras WHERE id = %s RETURNING id", (camera_id,))
        row = cur.fetchone()
        conn.commit()
        return row is not None
