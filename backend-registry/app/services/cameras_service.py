"""Business logic for cameras — raw SQL via psycopg, no ORM."""
from datetime import datetime, timezone


def list_cameras(conn, dept: str | None = None):
    with conn.cursor() as cur:
        if dept is None:
            cur.execute("""
                SELECT id, name, dept, ST_Y(location::geometry) AS lat,
                       ST_X(location::geometry) AS long, camera_type, ownership,
                       connectivity_status, storage_type, retention_days,
                       health_status, rtsp_url, stream_id, hls_url, circle_id
                FROM cameras
                WHERE is_synthetic = false
                ORDER BY id
            """)
        else:
            cur.execute("""
                SELECT id, name, dept, ST_Y(location::geometry) AS lat,
                       ST_X(location::geometry) AS long, camera_type, ownership,
                       connectivity_status, storage_type, retention_days,
                       health_status, rtsp_url, stream_id, hls_url, circle_id
                FROM cameras
                WHERE dept = %s AND is_synthetic = false
                ORDER BY id
            """, (dept,))
        cols = [c.name for c in cur.description]
        rows = cur.fetchall()
        return [dict(zip(cols, row)) for row in rows]


MAX_PAGE_LIMIT = 500

_CAMERA_COLUMNS = """id, name, dept, ST_Y(location::geometry) AS lat,
                     ST_X(location::geometry) AS long, camera_type, ownership,
                     connectivity_status, storage_type, retention_days,
                     health_status, rtsp_url, stream_id, hls_url, circle_id,
                     is_synthetic, edge_node_id"""


def list_cameras_page(
    conn,
    cursor: int | None = None,
    limit: int = 100,
    include_synthetic: bool = False,
    dept: str | None = None,
    bbox: tuple[float, float, float, float] | None = None,
) -> dict:
    """Keyset-paginated camera listing. bbox is (min_lat, max_lat, min_long, max_long).
    limit is always capped server-side at MAX_PAGE_LIMIT, regardless of what's requested --
    this endpoint must never be able to return all 80,000+ rows in one response."""
    limit = min(limit, MAX_PAGE_LIMIT)
    clauses = []
    params: dict = {"limit": limit + 1}  # fetch one extra to know if there's a next page

    if include_synthetic:
        clauses.append("is_synthetic = true")
    else:
        clauses.append("is_synthetic = false")
    if cursor is not None:
        clauses.append("id > %(cursor)s")
        params["cursor"] = cursor
    if dept is not None:
        clauses.append("dept = %(dept)s")
        params["dept"] = dept
    if bbox is not None:
        min_lat, max_lat, min_long, max_long = bbox
        clauses.append(
            "location && ST_MakeEnvelope(%(min_long)s, %(min_lat)s, %(max_long)s, %(max_lat)s, 4326)::geography"
        )
        params.update(min_lat=min_lat, max_lat=max_lat, min_long=min_long, max_long=max_long)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT {_CAMERA_COLUMNS} FROM cameras {where} ORDER BY id LIMIT %(limit)s",
            params,
        )
        cols = [c.name for c in cur.description]
        rows = [dict(zip(cols, row)) for row in cur.fetchall()]

    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        next_cursor = rows[-1]["id"]

    return {"cameras": rows, "next_cursor": next_cursor}


def get_camera(conn, camera_id: int):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, dept, ST_Y(location::geometry) AS lat,
                   ST_X(location::geometry) AS long, camera_type, ownership,
                   connectivity_status, storage_type, retention_days,
                   health_status, rtsp_url, stream_id, hls_url, circle_id
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
                health_status, rtsp_url, stream_id, hls_url, circle_id
            )
            VALUES (
                %(name)s, %(dept)s,
                ST_SetSRID(ST_MakePoint(%(long)s, %(lat)s), 4326),
                %(camera_type)s, %(ownership)s, %(connectivity_status)s,
                %(storage_type)s, %(retention_days)s, %(health_status)s,
                %(rtsp_url)s, %(stream_id)s, %(hls_url)s, %(circle_id)s
            )
            RETURNING id
        """, {**data, "stream_id": data.get("stream_id"), "hls_url": data.get("hls_url"),
              "circle_id": data.get("circle_id")})
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


def get_uptime_windows(conn, camera_id: int) -> list[dict] | None:
    """Pairs consecutive camera_status_history rows into windows: each row's
    status holds from its own changed_at until the next row's changed_at
    (or until now, for the most recent row -- that window is still open)."""
    camera = get_camera(conn, camera_id)
    if camera is None:
        return None

    with conn.cursor() as cur:
        cur.execute(
            "SELECT connectivity_status, changed_at FROM camera_status_history "
            "WHERE camera_id = %s ORDER BY changed_at",
            (camera_id,),
        )
        rows = cur.fetchall()

    windows = []
    now = datetime.now(timezone.utc)
    for i, (status, changed_at) in enumerate(rows):
        window_end = rows[i + 1][1] if i + 1 < len(rows) else None
        end_for_duration = window_end if window_end is not None else now
        windows.append({
            "status": status,
            "from": changed_at,
            "to": window_end,
            "duration_seconds": (end_for_duration - changed_at).total_seconds(),
        })
    return windows


def delete_camera(conn, camera_id: int) -> bool:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM cameras WHERE id = %s RETURNING id", (camera_id,))
        row = cur.fetchone()
        conn.commit()
        return row is not None


def get_summary(conn) -> dict:
    """One aggregate query against the indexes from Task 1 -- never fetches
    individual camera rows to count in Python, so this stays fast at 80,000+ rows."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE connectivity_status = 'online') AS online,
                COUNT(*) FILTER (WHERE connectivity_status = 'degraded') AS degraded,
                COUNT(*) FILTER (WHERE connectivity_status = 'offline') AS offline,
                COUNT(*) FILTER (WHERE is_synthetic = false) AS real_stream_count,
                COUNT(*) FILTER (WHERE is_synthetic = true) AS synthetic_count
            FROM cameras
        """)
        row = cur.fetchone()
        cur.execute("SELECT COUNT(*) FROM edge_nodes")
        edge_node_count = cur.fetchone()[0]

    return {
        "total": row[0],
        "online": row[1],
        "degraded": row[2],
        "offline": row[3],
        "real_stream_count": row[4],
        "synthetic_count": row[5],
        "edge_node_count": edge_node_count,
    }


def get_district_summary(conn, bbox: tuple[float, float, float, float] | None = None) -> list[dict]:
    """Real SQL GROUP BY district -- this is what the zoomed-out map view
    calls instead of counting a single truncated page of cameras client-side,
    which would under-report any district with more cameras than fit in one
    page. bbox is (min_lat, max_lat, min_long, max_long)."""
    # District summary is exclusively the scale-demo's zoomed-out map panel
    # (ScaleMap.tsx's "District Summary (Simulation)") -- it must only ever
    # reflect synthetic data, same as the per-camera markers it sits beside.
    clauses = ["is_synthetic = true"]
    params: dict = {}
    if bbox is not None:
        min_lat, max_lat, min_long, max_long = bbox
        clauses.append(
            "location && ST_MakeEnvelope(%(min_long)s, %(min_lat)s, %(max_long)s, %(max_lat)s, 4326)::geography"
        )
        params.update(min_lat=min_lat, max_lat=max_lat, min_long=min_long, max_long=max_long)
    where = f"WHERE {' AND '.join(clauses)}"

    with conn.cursor() as cur:
        cur.execute(
            f"SELECT dept AS district, COUNT(*) AS count FROM cameras {where} GROUP BY dept ORDER BY count DESC",
            params,
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]
