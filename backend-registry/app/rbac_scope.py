"""Multi-posting jurisdiction resolution -- shared by district-scoped
endpoints across several routers and federation_proxy.py (the mounted
inventory proxy), so all of them filter by an officer's real effective
jurisdiction the same way. Extracted out of main.py rather than duplicated:
two copies of this exact logic drifting apart is exactly how the federation
proxy's own single-scope_value bug happened in the first place (see
federation_proxy.py's module docstring)."""
from fastapi import HTTPException

from .services import rbac_service


def effective_district_scopes(user: dict) -> list[str] | None:
    """Multi-role jurisdiction (spec Section 3.3): "effective jurisdiction is
    the union of every active posting's scope." Returns None for
    platform-wide (no filter -- sees/manages everything), an empty list for
    "holds no district jurisdiction at all" (a pending officer with zero
    postings, or a legacy token that somehow carries neither), or the
    deduplicated list of every district this officer is actively posted to.

    Falls back to the token's single legacy scope_type/scope_value pair
    when no `scopes` claim is present at all -- every hand-crafted test/demo
    token, and any token issued before multi-posting existed."""
    scopes = user.get("scopes")
    if scopes is None:
        if user.get("scope_type") == "district":
            return [user.get("scope_value")]
        # Platform, or a legacy hand-crafted token with no scope_type claim
        # at all -- both are unrestricted, matching this codebase's original
        # single-scope behavior before multi-posting existed. Only a real
        # RBAC-issued token's *explicit*, empty `scopes` list (an officer
        # who genuinely holds zero active postings) means "no jurisdiction".
        return None
    if not scopes:
        return []
    if any(s.get("scope_type") == "platform" for s in scopes):
        return None
    return sorted({s["scope_value"] for s in scopes if s.get("scope_type") == "district" and s.get("scope_value")})


def resolve_district_scoped(dept_scopes: list[str] | None, fetch_all, fetch_by_district):
    """Applies effective_district_scopes' result to a single-district-filter
    fetch function: None -> no filter (fetch_all), [] -> no jurisdiction at
    all (empty, never fetch_all), one district -> the existing single-value
    path unchanged, several -> merge each district's rows, deduped by id."""
    if dept_scopes is None:
        return fetch_all()
    if not dept_scopes:
        return []
    if len(dept_scopes) == 1:
        return fetch_by_district(dept_scopes[0])
    merged: dict[int, dict] = {}
    for district in dept_scopes:
        for row in fetch_by_district(district):
            merged[row["id"]] = row
    return list(merged.values())


def guard_delegated_posting_assignment(conn, user: dict, role: dict, scope_type: str, scope_value: str | None) -> None:
    """Delegated admin (spec Section 6/3.8): a platform-wide actor (Super
    Admin) can assign anything. A district-scoped actor with
    can_delegate_admin (District Command) can only assign within one of
    their own effective jurisdictions -- the union of every active
    posting's district scope (spec Section 3.3), never a district outside
    all of them -- and, now that roles are dynamic (data, not a fixed
    5-name list), only roles whose hierarchy_level is strictly junior to
    their own: a role's numeric level increases the more junior it is
    (super_admin=1 is senior-most), and NULL means "outside the
    operational hierarchy" (e.g. auditor), always assignable by a delegate.
    An actor whose own role can't be resolved, or carries no
    hierarchy_level itself, can't safely compare levels at all and is
    denied by default. Shared by both direct posting assignment
    (routers/postings.py's create_posting) and approving a registration
    (routers/registration_admin.py's approve_registration, which is really
    just "assign this person's first posting").

    A district-scoped posting with no scope_value is checked here, before
    the platform-actor early-return below -- a district posting with
    scope_value=None resolves to "zero effective jurisdiction" everywhere
    else in this codebase (effective_district_scopes filters out falsy
    scope_values entirely), so it silently grants a role with no actual
    camera/data access. That's a real, previously-possible bug: a
    Super Admin approving a registration with the District field left
    blank produced exactly this. Checked unconditionally, before the
    platform-actor early-return, since a Super Admin is exactly who was
    able to slip past it."""
    if scope_type == "district" and not scope_value:
        raise HTTPException(status_code=400, detail="A district-scoped role requires a district")

    actor_district_scopes = effective_district_scopes(user)
    if actor_district_scopes is None:
        return
    if scope_type != "district" or scope_value not in actor_district_scopes:
        raise HTTPException(status_code=403, detail="Cannot assign outside your own jurisdiction")
    actor_role = rbac_service.get_role_by_name(conn, user.get("role", ""))
    actor_level = actor_role["hierarchy_level"] if actor_role else None
    target_level = role["hierarchy_level"]
    if actor_level is None or (target_level is not None and target_level <= actor_level):
        raise HTTPException(status_code=403, detail="Cannot assign a role at or above your own")
