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
