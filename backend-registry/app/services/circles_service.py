"""Business logic for circles — raw SQL via psycopg, no ORM."""
from psycopg.errors import UniqueViolation

_CIRCLE_COLUMNS = "id, name, district, created_at"


class DuplicateCircleError(Exception):
    """Raised when (district, name) already exists — the router maps this to 409."""


class CircleInUseError(Exception):
    """Raised when deleting a circle that still has cameras assigned — the
    router maps this to 400."""


def list_circles(conn, district: str | None = None) -> list[dict]:
    with conn.cursor() as cur:
        if district is None:
            cur.execute(f"SELECT {_CIRCLE_COLUMNS} FROM circles ORDER BY district, name")
        else:
            cur.execute(
                f"SELECT {_CIRCLE_COLUMNS} FROM circles WHERE district = %s ORDER BY name",
                (district,),
            )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_circle(conn, circle_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(f"SELECT {_CIRCLE_COLUMNS} FROM circles WHERE id = %s", (circle_id,))
        row = cur.fetchone()
        if row is None:
            return None
        cols = [c.name for c in cur.description]
        return dict(zip(cols, row))


def create_circle(conn, data: dict) -> dict:
    with conn.cursor() as cur:
        try:
            cur.execute(
                "INSERT INTO circles (name, district) VALUES (%(name)s, %(district)s) RETURNING id",
                data,
            )
        except UniqueViolation:
            conn.rollback()
            raise DuplicateCircleError(f"Circle '{data['name']}' already exists in {data['district']}")
        circle_id = cur.fetchone()[0]
        conn.commit()
    return get_circle(conn, circle_id)


def update_circle(conn, circle_id: int, data: dict) -> dict | None:
    fields = {k: v for k, v in data.items() if v is not None}
    if not fields:
        return get_circle(conn, circle_id)
    set_clauses = [f"{key} = %({key})s" for key in fields]
    with conn.cursor() as cur:
        try:
            cur.execute(
                f"UPDATE circles SET {', '.join(set_clauses)} WHERE id = %(circle_id)s RETURNING id",
                {**fields, "circle_id": circle_id},
            )
        except UniqueViolation:
            conn.rollback()
            raise DuplicateCircleError("Circle name already in use in this district")
        row = cur.fetchone()
        conn.commit()
        if row is None:
            return None
    return get_circle(conn, circle_id)


def delete_circle(conn, circle_id: int) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM cameras WHERE circle_id = %s", (circle_id,))
        if cur.fetchone()[0] > 0:
            raise CircleInUseError("Cannot delete a circle that still has cameras assigned")
        cur.execute("DELETE FROM circles WHERE id = %s", (circle_id,))
        deleted = cur.rowcount > 0
        conn.commit()
    return deleted
