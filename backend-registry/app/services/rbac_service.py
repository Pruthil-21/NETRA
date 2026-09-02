"""Business logic for roles, permissions, officers, and postings -- raw SQL via psycopg."""


def list_roles(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, display_name, hierarchy_level, can_delegate_admin "
            "FROM roles ORDER BY hierarchy_level NULLS LAST, name"
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def get_role_by_name(conn, name: str) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, display_name, hierarchy_level, can_delegate_admin "
            "FROM roles WHERE name = %s",
            (name,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        cols = [c.name for c in cur.description]
        return dict(zip(cols, row))


def role_permissions(conn, role_id: int) -> list[str]:
    with conn.cursor() as cur:
        cur.execute("SELECT permission FROM role_permissions WHERE role_id = %s", (role_id,))
        return [row[0] for row in cur.fetchall()]
