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


# The fixed catalog of valid permission strings -- matches scripts/seed_rbac.py's
# PERMISSIONS values. Editing a role's permissions can only select from this
# set, so a typo'd string doesn't silently do nothing.
VALID_PERMISSIONS = {
    "view_live_feeds", "search_vehicles", "edit_watchlist", "manage_cameras",
    "view_analytics", "export_data", "manage_users_roles", "view_audit_logs",
    "acknowledge_alerts", "manage_roles",
}


def list_roles_with_permissions(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, display_name, hierarchy_level, can_delegate_admin "
            "FROM roles ORDER BY hierarchy_level NULLS LAST, name"
        )
        cols = [c.name for c in cur.description]
        roles = [dict(zip(cols, row)) for row in cur.fetchall()]
    return [{**role, "permissions": role_permissions(conn, role["id"])} for role in roles]


def set_role_permissions(conn, role_id: int, permissions: list[str]) -> list[str]:
    """Replaces a role's entire permission set -- same delete-then-insert
    pattern as scripts/seed_rbac.py's seed(), never a partial add/remove."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM role_permissions WHERE role_id = %s", (role_id,))
        for permission in permissions:
            cur.execute(
                "INSERT INTO role_permissions (role_id, permission) VALUES (%s, %s)",
                (role_id, permission),
            )
    conn.commit()
    return permissions
