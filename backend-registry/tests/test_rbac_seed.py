import subprocess
import sys

from app.db import get_conn


def test_seed_creates_five_roles_with_correct_permissions():
    subprocess.run([sys.executable, "scripts/seed_rbac.py"], check=True)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT name, hierarchy_level, can_delegate_admin FROM roles ORDER BY name")
            rows = {r[0]: (r[1], r[2]) for r in cur.fetchall()}

    assert set(rows.keys()) == {
        "super_admin", "district_command", "station_officer",
        "control_room_operator", "auditor",
    }
    assert rows["super_admin"] == (1, True)
    assert rows["district_command"] == (2, True)
    assert rows["station_officer"] == (3, False)
    assert rows["control_room_operator"] == (4, False)
    assert rows["auditor"][0] is None  # outside the operational hierarchy


def test_seed_is_idempotent():
    subprocess.run([sys.executable, "scripts/seed_rbac.py"], check=True)
    subprocess.run([sys.executable, "scripts/seed_rbac.py"], check=True)  # must not error or duplicate

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM roles")
            assert cur.fetchone()[0] == 5


def test_auditor_has_only_view_audit_logs_permission():
    subprocess.run([sys.executable, "scripts/seed_rbac.py"], check=True)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT rp.permission FROM role_permissions rp "
                "JOIN roles r ON r.id = rp.role_id WHERE r.name = 'auditor'"
            )
            perms = {row[0] for row in cur.fetchall()}
    assert perms == {"view_audit_logs"}


def test_control_room_operator_cannot_edit_watchlist_or_export():
    subprocess.run([sys.executable, "scripts/seed_rbac.py"], check=True)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT rp.permission FROM role_permissions rp "
                "JOIN roles r ON r.id = rp.role_id WHERE r.name = 'control_room_operator'"
            )
            perms = {row[0] for row in cur.fetchall()}
    assert perms == {"view_live_feeds", "acknowledge_alerts"}
    assert "edit_watchlist" not in perms
    assert "export_data" not in perms


def test_valid_permissions_covers_every_seeded_permission():
    """Regression guard: rbac_service.VALID_PERMISSIONS must contain every
    permission scripts/seed_rbac.py grants to any role, or a super_admin
    editing that role's permissions via PUT /admin/roles/{name}/permissions
    would be rejected as "unknown permission" for a permission the role
    already has in the seeded database."""
    import sys
    sys.path.insert(0, "scripts")
    from seed_rbac import PERMISSIONS

    from app.services.rbac_service import VALID_PERMISSIONS

    all_seeded = {perm for perms in PERMISSIONS.values() for perm in perms}
    missing = all_seeded - VALID_PERMISSIONS
    assert not missing, f"VALID_PERMISSIONS is missing: {missing}"
