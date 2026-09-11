"""Business logic for areas — raw SQL via psycopg, no ORM."""
from psycopg.errors import UniqueViolation

# Denormalized district/taluka/village names via join -- every caller needs
# "where actually is this area" for display (the admin page's cascading
# picker, the Add Camera modal's search results), and doing that as 3
# separate per-area lookups doesn't scale once areas exist across many
# villages. area.district_id is the join's district_id, used by
# _guard_area_district's RBAC check below -- not part of AreaOut's schema.
_AREA_SELECT = """
    SELECT a.id, a.name, a.village_id, a.created_at,
           v.name AS village, t.name AS taluka, d.name AS district, d.id AS district_id
    FROM areas a
    JOIN villages v ON v.id = a.village_id
    JOIN talukas t ON t.id = v.taluka_id
    JOIN districts d ON d.id = t.district_id
"""


class DuplicateAreaError(Exception):
    """Raised when (village_id, name) already exists — the router maps this to 409."""


class AreaInUseError(Exception):
    """Raised when deleting an area that still has cameras assigned — the
    router maps this to 400."""


def _rows(cur) -> list[dict]:
    cols = [c.name for c in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def list_areas(conn, district_name: str | None = None, village_id: int | None = None, search: str | None = None) -> list[dict]:
    """`district_name` scopes to one district by name (matches cameras.dept /
    posting scope_value convention -- see rbac_scope.py); `village_id` scopes
    to one village (the admin page's cascading picker); `search` filters by
    area name substring (the Add Camera modal's type-to-search field). Any
    combination may be passed together."""
    clauses = []
    params: dict = {}
    if district_name is not None:
        clauses.append("d.name = %(district_name)s")
        params["district_name"] = district_name
    if village_id is not None:
        clauses.append("a.village_id = %(village_id)s")
        params["village_id"] = village_id
    if search:
        clauses.append("a.name ILIKE %(search)s")
        params["search"] = f"%{search}%"
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with conn.cursor() as cur:
        cur.execute(f"{_AREA_SELECT} {where} ORDER BY d.name, t.name, v.name, a.name", params)
        return _rows(cur)


def get_area(conn, area_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(f"{_AREA_SELECT} WHERE a.id = %s", (area_id,))
        rows = _rows(cur)
        return rows[0] if rows else None


def create_area(conn, data: dict) -> dict:
    with conn.cursor() as cur:
        try:
            cur.execute(
                "INSERT INTO areas (name, village_id) VALUES (%(name)s, %(village_id)s) RETURNING id",
                data,
            )
        except UniqueViolation:
            conn.rollback()
            raise DuplicateAreaError(f"Area '{data['name']}' already exists in this village")
        area_id = cur.fetchone()[0]
        conn.commit()
    return get_area(conn, area_id)


def update_area(conn, area_id: int, data: dict) -> dict | None:
    fields = {k: v for k, v in data.items() if v is not None}
    if not fields:
        return get_area(conn, area_id)
    set_clauses = [f"{key} = %({key})s" for key in fields]
    with conn.cursor() as cur:
        try:
            cur.execute(
                f"UPDATE areas SET {', '.join(set_clauses)} WHERE id = %(area_id)s RETURNING id",
                {**fields, "area_id": area_id},
            )
        except UniqueViolation:
            conn.rollback()
            raise DuplicateAreaError("Area name already in use in this village")
        row = cur.fetchone()
        conn.commit()
        if row is None:
            return None
    return get_area(conn, area_id)


def camera_count_for_area(conn, area_id: int) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM cameras WHERE area_id = %s", (area_id,))
        return cur.fetchone()[0]


def delete_area(conn, area_id: int) -> bool:
    with conn.cursor() as cur:
        if camera_count_for_area(conn, area_id) > 0:
            raise AreaInUseError("Cannot delete an area that still has cameras assigned")
        cur.execute("DELETE FROM areas WHERE id = %s", (area_id,))
        deleted = cur.rowcount > 0
        conn.commit()
    return deleted
