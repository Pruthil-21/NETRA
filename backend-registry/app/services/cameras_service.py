"""Business logic for cameras — raw SQL via psycopg, no ORM."""
from datetime import datetime, timezone


def list_cameras(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM cameras ORDER BY id")
        rows = cur.fetchall()
    return [dict(r) for r in rows]


def get_camera(conn, camera_id: int):
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM cameras WHERE id = %s", (camera_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def create_camera(conn, data: dict):
    """Insert a camera and return it (with its id)."""
    fields = {k: v for k, v in data.items() if v is not None}
    if "lat" in fields and "long" in fields:
        fields["location"] = f"SRID=4326;POINT({fields['long']} {fields['lat']})"
        del fields["lat"]
        del fields["long"]

    set_clauses = [f"{key} = %({key})s" for key in fields]
    with conn.cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO cameras ({', '.join(fields.keys())})
            VALUES ({', '.join(f'%({k})s' for k in fields.keys())})
            RETURNING id
        """,
            fields,
        )
        row = cur.fetchone()
        camera_id = row[0]
        conn.commit()
    return get_camera(conn, camera_id)


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
    """Delete and return True if found, False otherwise."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM cameras WHERE id = %s", (camera_id,))
        deleted = cur.rowcount > 0
        conn.commit()
    return deleted
