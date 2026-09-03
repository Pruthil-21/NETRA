"""Business logic for coverage targets -- checkpoints/junctions that should
have camera coverage, compared against real cameras in gap_analysis_service."""


def _row_to_dict(row) -> dict:
    return {
        "id": row[0],
        "name": row[1],
        "lat": row[2],
        "long": row[3],
        "district": row[4],
        "priority": row[5],
    }


_SELECT = """
    SELECT id, name, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS long,
           district, priority
    FROM coverage_targets
"""


def list_targets(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(_SELECT + " ORDER BY id")
        rows = cur.fetchall()
    return [_row_to_dict(r) for r in rows]


def get_target(conn, target_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(_SELECT + " WHERE id = %s", (target_id,))
        row = cur.fetchone()
    return _row_to_dict(row) if row else None


def create_target(conn, data: dict) -> dict:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO coverage_targets (name, location, district, priority)
            VALUES (%(name)s, ST_SetSRID(ST_MakePoint(%(long)s, %(lat)s), 4326), %(district)s, %(priority)s)
            RETURNING id
            """,
            data,
        )
        target_id = cur.fetchone()[0]
        conn.commit()
    return get_target(conn, target_id)


def update_target(conn, target_id: int, data: dict) -> dict | None:
    fields = {k: v for k, v in data.items() if v is not None}
    if not fields:
        return get_target(conn, target_id)

    set_clauses = [f"{key} = %({key})s" for key in fields if key not in ("lat", "long")]
    if "lat" in fields and "long" in fields:
        set_clauses.append("location = ST_SetSRID(ST_MakePoint(%(long)s, %(lat)s), 4326)")

    with conn.cursor() as cur:
        cur.execute(
            f"UPDATE coverage_targets SET {', '.join(set_clauses)} WHERE id = %(target_id)s RETURNING id",
            {**fields, "target_id": target_id},
        )
        row = cur.fetchone()
        conn.commit()
        if row is None:
            return None
    return get_target(conn, target_id)


def delete_target(conn, target_id: int) -> bool:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM coverage_targets WHERE id = %s", (target_id,))
        deleted = cur.rowcount > 0
        conn.commit()
    return deleted
