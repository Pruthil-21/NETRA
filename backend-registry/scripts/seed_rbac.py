"""Seeds the 5 demo RBAC roles and their permission sets. Idempotent --
safe to run against an already-seeded database (upserts by role name)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.db import get_conn

# ROLE, display name, hierarchy_level (None = outside the operational chain), can_delegate_admin
ROLES = [
    ("super_admin", "Super Admin", 1, True),
    ("district_command", "District Command", 2, True),
    ("station_officer", "Station Officer", 3, False),
    ("control_room_operator", "Control Room Operator", 4, False),
    ("auditor", "Auditor", None, False),
]

PERMISSIONS = {
    "super_admin": [
        "view_live_feeds", "search_vehicles", "edit_watchlist", "manage_cameras",
        "view_analytics", "export_data", "manage_users_roles", "view_audit_logs",
        "acknowledge_alerts", "manage_roles",
    ],
    "district_command": [
        "view_live_feeds", "search_vehicles", "edit_watchlist", "manage_cameras",
        "view_analytics", "export_data", "manage_users_roles", "acknowledge_alerts",
        "view_audit_logs",
    ],
    "station_officer": [
        "view_live_feeds", "search_vehicles", "edit_watchlist", "acknowledge_alerts",
    ],
    "control_room_operator": ["view_live_feeds", "acknowledge_alerts"],
    "auditor": ["view_audit_logs"],
}


def seed():
    with get_conn() as conn:
        with conn.cursor() as cur:
            for name, display_name, level, can_delegate in ROLES:
                cur.execute(
                    """
                    INSERT INTO roles (name, display_name, hierarchy_level, can_delegate_admin)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (name) DO UPDATE SET
                        display_name = EXCLUDED.display_name,
                        hierarchy_level = EXCLUDED.hierarchy_level,
                        can_delegate_admin = EXCLUDED.can_delegate_admin
                    RETURNING id
                    """,
                    (name, display_name, level, can_delegate),
                )
                role_id = cur.fetchone()[0]

                cur.execute("DELETE FROM role_permissions WHERE role_id = %s", (role_id,))
                for perm in PERMISSIONS[name]:
                    cur.execute(
                        "INSERT INTO role_permissions (role_id, permission) VALUES (%s, %s)",
                        (role_id, perm),
                    )
        conn.commit()
    print(f"Seeded {len(ROLES)} roles.")


if __name__ == "__main__":
    seed()
