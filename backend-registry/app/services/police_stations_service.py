"""Business logic for police stations -- shown as map pins and used for
nearest-station alert enrichment (see backend-watchlist's alerts_service)."""


def _row_to_dict(row) -> dict:
    return {
        "id": row[0], "name": row[1], "lat": row[2], "long": row[3],
        "district": row[4], "contact": row[5],
    }


_SELECT = """
    SELECT id, name, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS long,
           district, contact
    FROM police_stations
"""


def list_stations(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(_SELECT + " ORDER BY id")
        rows = cur.fetchall()
    return [_row_to_dict(r) for r in rows]


def get_station(conn, station_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(_SELECT + " WHERE id = %s", (station_id,))
        row = cur.fetchone()
    return _row_to_dict(row) if row else None


def create_station(conn, data: dict) -> dict:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO police_stations (name, location, district, contact)
            VALUES (%(name)s, ST_SetSRID(ST_MakePoint(%(long)s, %(lat)s), 4326), %(district)s, %(contact)s)
            RETURNING id
            """,
            data,
        )
        station_id = cur.fetchone()[0]
        conn.commit()
    return get_station(conn, station_id)


def update_station(conn, station_id: int, data: dict) -> dict | None:
    fields = {k: v for k, v in data.items() if v is not None}
    if not fields:
        return get_station(conn, station_id)

    set_clauses = [f"{key} = %({key})s" for key in fields if key not in ("lat", "long")]
    if "lat" in fields and "long" in fields:
        set_clauses.append("location = ST_SetSRID(ST_MakePoint(%(long)s, %(lat)s), 4326)")

    if not set_clauses:
        # A lone lat or long (no partner coordinate, and nothing else to set)
        # falls through with nothing to update -- treat it as a no-op rather
        # than issuing "UPDATE ... SET  WHERE ..." (a SQL syntax error).
        return get_station(conn, station_id)

    with conn.cursor() as cur:
        cur.execute(
            f"UPDATE police_stations SET {', '.join(set_clauses)} WHERE id = %(station_id)s RETURNING id",
            {**fields, "station_id": station_id},
        )
        row = cur.fetchone()
        conn.commit()
        if row is None:
            return None
    return get_station(conn, station_id)


def delete_station(conn, station_id: int) -> bool:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM police_stations WHERE id = %s", (station_id,))
        deleted = cur.rowcount > 0
        conn.commit()
    return deleted
