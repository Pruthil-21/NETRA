"""Phase A of the RBAC v2 spec: duties as reusable permission bundles, role
composition from duties, role hierarchy (parent/clone), and deactivate-vs-
hard-delete. Exercises app.services.rbac_service directly -- these are the
structural building blocks the admin API (roles/duties endpoints) sits on."""
import subprocess
import sys

import pytest
from app.db import get_conn
from app.services import rbac_service


def _seed(cwd=None):
    subprocess.run([sys.executable, "scripts/seed_rbac.py"], check=True)
    subprocess.run([sys.executable, "scripts/seed_demo_officers.py"], check=True)


@pytest.fixture(autouse=True)
def _clean_duties_and_test_roles():
    """Every test in this file creates its own duties/roles -- delete them
    (and any role_duties/role_permissions rows referencing them) after each
    test so one test's fixture data can't leak into the next."""
    yield
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM duties WHERE name LIKE 'test_%'")
            cur.execute("DELETE FROM roles WHERE name LIKE 'test_%'")
        conn.commit()


def test_create_duty_bundles_permissions_under_one_name():
    with get_conn() as conn:
        duty = rbac_service.create_duty(
            conn, "test_watchlist_mgmt", "Watchlist Management",
            "Add/remove watchlist entries and view analytics",
            ["edit_watchlist", "view_analytics"],
        )
        perms = rbac_service.duty_permissions(conn, duty["id"])
    assert duty["name"] == "test_watchlist_mgmt"
    assert set(perms) == {"edit_watchlist", "view_analytics"}


def test_create_duty_rejects_unknown_permission():
    with pytest.raises(ValueError):
        with get_conn() as conn:
            rbac_service.create_duty(conn, "test_bad_duty", "Bad Duty", None, ["not_a_real_permission"])


def test_update_duty_replaces_its_permission_set():
    with get_conn() as conn:
        duty = rbac_service.create_duty(conn, "test_cam_admin", "Camera Administration", None, ["manage_cameras"])
        updated = rbac_service.update_duty(conn, duty["id"], permissions=["manage_cameras", "view_analytics"])
        perms = rbac_service.duty_permissions(conn, updated["id"])
    assert set(perms) == {"manage_cameras", "view_analytics"}


def test_role_composed_from_duties_has_union_of_their_permissions():
    with get_conn() as conn:
        duty_a = rbac_service.create_duty(conn, "test_duty_a", "Duty A", None, ["view_live_feeds"])
        duty_b = rbac_service.create_duty(conn, "test_duty_b", "Duty B", None, ["acknowledge_alerts"])
        role = rbac_service.create_role(
            conn, "test_composed_role", "Composed Role", hierarchy_level=None,
            can_delegate_admin=False, duty_ids=[duty_a["id"], duty_b["id"]],
        )
        effective = rbac_service.effective_role_permissions(conn, role["id"])
    assert set(effective) == {"view_live_feeds", "acknowledge_alerts"}


def test_effective_permissions_union_direct_and_duty_permissions():
    """A role can still carry direct role_permissions (the rare/advanced
    path) alongside duties -- effective permissions is the union of both,
    never just one or the other."""
    with get_conn() as conn:
        duty = rbac_service.create_duty(conn, "test_duty_c", "Duty C", None, ["view_live_feeds"])
        role = rbac_service.create_role(
            conn, "test_direct_plus_duty", "Direct Plus Duty", hierarchy_level=None,
            can_delegate_admin=False, duty_ids=[duty["id"]], permissions=["export_data"],
        )
        effective = rbac_service.effective_role_permissions(conn, role["id"])
    assert set(effective) == {"view_live_feeds", "export_data"}


def test_new_role_can_inherit_duties_from_a_parent_role():
    with get_conn() as conn:
        duty = rbac_service.create_duty(conn, "test_parent_duty", "Parent Duty", None, ["manage_stations"])
        parent = rbac_service.create_role(
            conn, "test_parent_role", "Parent Role", hierarchy_level=None,
            can_delegate_admin=False, duty_ids=[duty["id"]],
        )
        child = rbac_service.create_role(
            conn, "test_child_role", "Child Role", hierarchy_level=None,
            can_delegate_admin=False, parent_role_id=parent["id"],
        )
        assert child["parent_role_id"] == parent["id"]
        effective = rbac_service.effective_role_permissions(conn, child["id"])
    assert set(effective) == {"manage_stations"}


def test_clone_role_copies_duties_as_an_independent_snapshot():
    """Cloning copies the source's duty *assignment*, not a live reference --
    editing the clone's duty composition must never retroactively change the
    original role's effective permissions."""
    with get_conn() as conn:
        duty = rbac_service.create_duty(conn, "test_clone_duty", "Clone Duty", None, ["view_analytics"])
        source = rbac_service.create_role(
            conn, "test_source_role", "Source Role", hierarchy_level=None,
            can_delegate_admin=False, duty_ids=[duty["id"]],
        )
        clone = rbac_service.clone_role(conn, source["id"], "test_cloned_role", "Cloned Role")

        extra_duty = rbac_service.create_duty(conn, "test_extra_duty", "Extra Duty", None, ["export_data"])
        rbac_service.set_role_duties(conn, clone["id"], [duty["id"], extra_duty["id"]])

        source_perms = rbac_service.effective_role_permissions(conn, source["id"])
        clone_perms = rbac_service.effective_role_permissions(conn, clone["id"])
    assert set(source_perms) == {"view_analytics"}
    assert set(clone_perms) == {"view_analytics", "export_data"}


def test_role_with_zero_active_holders_can_be_hard_deleted():
    with get_conn() as conn:
        role = rbac_service.create_role(
            conn, "test_deletable_role", "Deletable Role", hierarchy_level=None, can_delegate_admin=False,
        )
        assert rbac_service.count_active_holders(conn, role["id"]) == 0
        deleted = rbac_service.delete_role(conn, role["id"])
    assert deleted is True


def test_role_with_an_active_holder_cannot_be_hard_deleted_only_deactivated():
    _seed()
    with get_conn() as conn:
        role = rbac_service.get_role_by_name(conn, "station_officer")
        with pytest.raises(rbac_service.RoleInUseError):
            rbac_service.delete_role(conn, role["id"])

        deactivated = rbac_service.deactivate_role(conn, role["id"])
        assert deactivated["is_active"] is False
        # existing holders are untouched -- deactivation blocks new
        # assignment, it never revokes what's already held.
        assert rbac_service.count_active_holders(conn, role["id"]) > 0

        rbac_service.reactivate_role(conn, role["id"])  # leave seed state clean for other tests


def test_system_seeded_role_can_never_be_hard_deleted_even_with_no_holders():
    _seed()
    with get_conn() as conn:
        # auditor has hierarchy_level None and, in a freshly-reseeded db,
        # may have zero holders -- is_system must block deletion regardless.
        role = rbac_service.get_role_by_name(conn, "auditor")
        with pytest.raises(rbac_service.RoleInUseError):
            rbac_service.delete_role(conn, role["id"])
