"""Business logic for roles, permissions, officers, and postings -- raw SQL via psycopg."""
import json


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
            "SELECT id, name, display_name, hierarchy_level, can_delegate_admin, "
            "parent_role_id, is_active, is_system FROM roles WHERE name = %s",
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
    "acknowledge_alerts", "manage_roles", "manage_stations", "manage_circles",
    "reset_officer_passwords",
}


def list_roles_with_permissions(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, display_name, hierarchy_level, can_delegate_admin, "
            "parent_role_id, is_active, is_system FROM roles ORDER BY hierarchy_level NULLS LAST, name"
        )
        cols = [c.name for c in cur.description]
        roles = [dict(zip(cols, row)) for row in cur.fetchall()]
    return [
        {**role, "duty_ids": get_role_duty_ids(conn, role["id"]), "permissions": role_permissions(conn, role["id"])}
        for role in roles
    ]


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


# --- Dynamic RBAC (v2 spec, Phase A): duties, role composition, hierarchy ---


class RoleInUseError(Exception):
    """Raised by delete_role for a role that must not be hard-deleted --
    either it's still held by at least one active posting, or it's one of
    the originally-seeded (is_system) roles. Both cases resolve to
    deactivate_role instead, never a delete."""


def _row_to_dict(cur, row):
    if row is None:
        return None
    cols = [c.name for c in cur.description]
    return dict(zip(cols, row))


def duty_permissions(conn, duty_id: int) -> list[str]:
    with conn.cursor() as cur:
        cur.execute("SELECT permission FROM duty_permissions WHERE duty_id = %s", (duty_id,))
        return [row[0] for row in cur.fetchall()]


def get_duty(conn, duty_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute("SELECT id, name, display_name, description, created_at FROM duties WHERE id = %s", (duty_id,))
        duty = _row_to_dict(cur, cur.fetchone())
    if duty is not None:
        duty["permissions"] = duty_permissions(conn, duty_id)
    return duty


def get_duty_by_name(conn, name: str) -> dict | None:
    with conn.cursor() as cur:
        cur.execute("SELECT id, name, display_name, description, created_at FROM duties WHERE name = %s", (name,))
        duty = _row_to_dict(cur, cur.fetchone())
    if duty is not None:
        duty["permissions"] = duty_permissions(conn, duty["id"])
    return duty


def list_duties(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute("SELECT id, name, display_name, description, created_at FROM duties ORDER BY name")
        duties = [_row_to_dict(cur, row) for row in cur.fetchall()]
    for duty in duties:
        duty["permissions"] = duty_permissions(conn, duty["id"])
    return duties


def _validate_permissions(permissions: list[str]) -> None:
    unknown = set(permissions) - VALID_PERMISSIONS
    if unknown:
        raise ValueError(f"Unknown permission(s): {', '.join(sorted(unknown))}")


def create_duty(conn, name: str, display_name: str, description: str | None, permissions: list[str]) -> dict:
    _validate_permissions(permissions)
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO duties (name, display_name, description) VALUES (%s, %s, %s) RETURNING id",
            (name, display_name, description),
        )
        duty_id = cur.fetchone()[0]
        for permission in permissions:
            cur.execute("INSERT INTO duty_permissions (duty_id, permission) VALUES (%s, %s)", (duty_id, permission))
    conn.commit()
    return get_duty(conn, duty_id)


def update_duty(
    conn, duty_id: int, display_name: str | None = None, description: str | None = None,
    permissions: list[str] | None = None,
) -> dict | None:
    if permissions is not None:
        _validate_permissions(permissions)
    with conn.cursor() as cur:
        if display_name is not None or description is not None:
            cur.execute(
                "UPDATE duties SET display_name = COALESCE(%s, display_name), "
                "description = COALESCE(%s, description) WHERE id = %s",
                (display_name, description, duty_id),
            )
        if permissions is not None:
            cur.execute("DELETE FROM duty_permissions WHERE duty_id = %s", (duty_id,))
            for permission in permissions:
                cur.execute(
                    "INSERT INTO duty_permissions (duty_id, permission) VALUES (%s, %s)", (duty_id, permission)
                )
    conn.commit()
    return get_duty(conn, duty_id)


def get_role_duty_ids(conn, role_id: int) -> list[int]:
    with conn.cursor() as cur:
        cur.execute("SELECT duty_id FROM role_duties WHERE role_id = %s", (role_id,))
        return [row[0] for row in cur.fetchall()]


def set_role_duties(conn, role_id: int, duty_ids: list[int]) -> None:
    """Replaces a role's entire duty composition -- same delete-then-insert
    pattern as set_role_permissions, never a partial add/remove."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM role_duties WHERE role_id = %s", (role_id,))
        for duty_id in duty_ids:
            cur.execute("INSERT INTO role_duties (role_id, duty_id) VALUES (%s, %s)", (role_id, duty_id))
    conn.commit()


def effective_role_permissions(conn, role_id: int) -> list[str]:
    """A role's real access: the union of its direct role_permissions (the
    rare/advanced path) and every permission bundled into any duty assigned
    to it (the primary, D365-style composition path) -- matches D365's "sum
    total access" rule applied one level down, from duties to a role."""
    direct = set(role_permissions(conn, role_id))
    for duty_id in get_role_duty_ids(conn, role_id):
        direct.update(duty_permissions(conn, duty_id))
    return sorted(direct)


def get_role(conn, role_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, name, display_name, hierarchy_level, can_delegate_admin, "
            "parent_role_id, is_active, is_system FROM roles WHERE id = %s",
            (role_id,),
        )
        return _row_to_dict(cur, cur.fetchone())


def create_role(
    conn, name: str, display_name: str, hierarchy_level: int | None, can_delegate_admin: bool,
    parent_role_id: int | None = None, duty_ids: list[int] | None = None, permissions: list[str] | None = None,
) -> dict:
    """Super Admin creating a brand-new role (spec Section 3.1) -- not just
    editing an existing one's permissions. A parent_role_id inherits that
    role's duty composition as a starting point (Section 2.2); duty_ids/
    permissions on top of that are additive, not exclusive alternatives to
    inheriting."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO roles (name, display_name, hierarchy_level, can_delegate_admin, parent_role_id)
            VALUES (%s, %s, %s, %s, %s) RETURNING id
            """,
            (name, display_name, hierarchy_level, can_delegate_admin, parent_role_id),
        )
        role_id = cur.fetchone()[0]
    conn.commit()

    inherited_duty_ids = get_role_duty_ids(conn, parent_role_id) if parent_role_id is not None else []
    all_duty_ids = sorted(set(inherited_duty_ids) | set(duty_ids or []))
    if all_duty_ids:
        set_role_duties(conn, role_id, all_duty_ids)
    if permissions:
        set_role_permissions(conn, role_id, permissions)
    return get_role(conn, role_id)


def clone_role(conn, source_role_id: int, new_name: str, new_display_name: str) -> dict:
    """Clones a role's duty composition and direct permissions as a fresh,
    independent snapshot -- editing the clone must never retroactively
    change the source (spec Section 3.1: "copies its duties, not a
    reference to them"). hierarchy_level/can_delegate_admin are copied too;
    the clone always starts as a brand-new, non-system, active role."""
    source = get_role(conn, source_role_id)
    if source is None:
        raise ValueError(f"Role {source_role_id} not found")
    clone = create_role(
        conn, new_name, new_display_name, source["hierarchy_level"], source["can_delegate_admin"],
        duty_ids=get_role_duty_ids(conn, source_role_id),
        permissions=role_permissions(conn, source_role_id),
    )
    return clone


def count_active_holders(conn, role_id: int) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(DISTINCT officer_id) FROM postings WHERE role_id = %s AND is_active", (role_id,))
        return cur.fetchone()[0]


def deactivate_role(conn, role_id: int) -> dict | None:
    """Blocks new assignment of this role; existing holders keep it until
    individually reassigned (spec Section 3.1) -- never touches postings."""
    with conn.cursor() as cur:
        cur.execute("UPDATE roles SET is_active = false WHERE id = %s", (role_id,))
    conn.commit()
    return get_role(conn, role_id)


def reactivate_role(conn, role_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute("UPDATE roles SET is_active = true WHERE id = %s", (role_id,))
    conn.commit()
    return get_role(conn, role_id)


# --- Separation-of-Duty rule engine (v2 spec, Phase D, Section 3.8) --------
# Generalizes Task 6's single hardcoded alert-escalation rule (which stays
# exactly as-is in backend-watchlist -- an activity-level check, "can't
# escalate what you already acted on") to role-pair conflicts checked at
# posting-assignment time instead: two roles that must never both be
# actively held by the same officer at once.


def list_sod_rules(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT sr.id, sr.role_a_id, ra.name AS role_a_name, sr.role_b_id, rb.name AS role_b_name,
                   sr.description, sr.created_at
            FROM sod_rules sr
            JOIN roles ra ON ra.id = sr.role_a_id
            JOIN roles rb ON rb.id = sr.role_b_id
            ORDER BY sr.created_at
            """
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def create_sod_rule(conn, role_id_1: int, role_id_2: int, description: str | None) -> dict:
    if role_id_1 == role_id_2:
        raise ValueError("A role cannot conflict with itself")
    role_a_id, role_b_id = sorted((role_id_1, role_id_2))
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO sod_rules (role_a_id, role_b_id, description) VALUES (%s, %s, %s) RETURNING id",
            (role_a_id, role_b_id, description),
        )
        rule_id = cur.fetchone()[0]
    conn.commit()
    return next(r for r in list_sod_rules(conn) if r["id"] == rule_id)


def delete_sod_rule(conn, rule_id: int) -> bool:
    with conn.cursor() as cur:
        cur.execute("DELETE FROM sod_rules WHERE id = %s RETURNING id", (rule_id,))
        found = cur.fetchone() is not None
    conn.commit()
    return found


def find_sod_conflict(conn, officer_id: int, candidate_role_id: int) -> dict | None:
    """Checked before adding a new posting (spec Section 3.8): would this
    role, combined with any of the officer's OTHER currently-active
    postings' roles, form a configured conflicting pair? Returns the
    conflicting rule (with both role names) if so, else None."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT role_id FROM postings WHERE officer_id = %s AND is_active "
            "AND (expires_at IS NULL OR expires_at > now())",
            (officer_id,),
        )
        held_role_ids = {row[0] for row in cur.fetchall()}
    if not held_role_ids:
        return None
    for rule in list_sod_rules(conn):
        pair = {rule["role_a_id"], rule["role_b_id"]}
        if candidate_role_id in pair:
            other = (pair - {candidate_role_id}).pop()
            if other in held_role_ids:
                return rule
    return None


# --- Draft/Publish for role edits (v2 spec, Phase D, Section 2.4/3.1) -----


def save_role_draft(conn, role_id: int, duty_ids: list[int], permissions: list[str], created_by: str | None) -> dict:
    """Stages a role's next duty/permission composition without touching
    what's actually live. One draft per role -- a second call replaces the
    first outright (ON CONFLICT), it never stacks multiple pending edits."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO role_drafts (role_id, draft_duty_ids, draft_permissions, created_by)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (role_id) DO UPDATE SET
                draft_duty_ids = EXCLUDED.draft_duty_ids,
                draft_permissions = EXCLUDED.draft_permissions,
                created_by = EXCLUDED.created_by,
                created_at = now()
            """,
            (role_id, json.dumps(duty_ids), json.dumps(permissions), created_by),
        )
    conn.commit()
    return get_role_draft(conn, role_id)


def get_role_draft(conn, role_id: int) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT role_id, draft_duty_ids, draft_permissions, created_by, created_at "
            "FROM role_drafts WHERE role_id = %s",
            (role_id,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        cols = [c.name for c in cur.description]
        return dict(zip(cols, row))


def diff_role_draft(conn, role_id: int) -> dict:
    """The "effective permissions diff" a Super Admin reviews before
    publishing (spec Sections 2.4/3.1/3.8): which permissions the draft
    would add/remove versus what's currently live, and how many currently-
    active officers hold this role right now (the blast radius of hitting
    publish). Diffing effective permissions (duties included), not just
    the raw duty_id list, is what makes this meaningful -- two different
    duty sets can still resolve to the same permissions, or vice versa."""
    draft = get_role_draft(conn, role_id)
    current_effective = set(effective_role_permissions(conn, role_id))
    if draft is None:
        return {
            "role_id": role_id, "has_draft": False, "added_permissions": [], "removed_permissions": [],
            "affected_active_holders": count_active_holders(conn, role_id),
        }

    draft_effective: set[str] = set(draft["draft_permissions"])
    for duty_id in draft["draft_duty_ids"]:
        draft_effective.update(duty_permissions(conn, duty_id))

    return {
        "role_id": role_id,
        "has_draft": True,
        "added_permissions": sorted(draft_effective - current_effective),
        "removed_permissions": sorted(current_effective - draft_effective),
        "affected_active_holders": count_active_holders(conn, role_id),
    }


def publish_role_draft(conn, role_id: int) -> dict | None:
    """Applies a pending draft to the live role, then clears it. Returns
    None (no-op) when there's no pending draft to publish."""
    draft = get_role_draft(conn, role_id)
    if draft is None:
        return None
    set_role_duties(conn, role_id, draft["draft_duty_ids"])
    set_role_permissions(conn, role_id, draft["draft_permissions"])
    with conn.cursor() as cur:
        cur.execute("DELETE FROM role_drafts WHERE role_id = %s", (role_id,))
    conn.commit()
    return get_role(conn, role_id)


def delete_role(conn, role_id: int) -> bool:
    """Hard-deletes a role only when it's safe to: never one of the 5
    originally-seeded (is_system) roles, and only when zero officers
    currently hold it as an active posting (spec Section 3.1). Cascades to
    role_permissions/role_duties via their FK ON DELETE CASCADE."""
    role = get_role(conn, role_id)
    if role is None:
        return False
    if role["is_system"]:
        raise RoleInUseError(f"'{role['name']}' is a system role and cannot be deleted")
    if count_active_holders(conn, role_id) > 0:
        raise RoleInUseError(f"'{role['name']}' is held by at least one active posting")
    with conn.cursor() as cur:
        cur.execute("DELETE FROM roles WHERE id = %s", (role_id,))
    conn.commit()
    return True
