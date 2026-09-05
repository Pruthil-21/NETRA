"""Read-side for audit_logs -- every mutating action across both services
already writes here (see audit_service.log in each); this is the first
place anything reads it back.

Every real action/resource_type pair written today (see audit_service.log
call sites in both services) is grouped into one of these categories, so a
police officer can filter by "what kind of thing happened" instead of
needing to know the raw action/resource_type strings. Modeled on the
category + actor + resource + time-range filtering used by mainstream
admin audit logs (Google Workspace, AWS CloudTrail, Okta System Log):
group first, then narrow by actor/resource/time within a group.

"other" is deliberately not listed here -- it's whatever doesn't match any
of these, computed as a fallback so a future action/resource_type that
nobody remembers to categorize still shows up somewhere instead of vanishing
from every category filter.
"""
CATEGORIES: dict[str, dict[str, list[str]]] = {
    "authentication": {"actions": ["login"]},
    "credentials": {"actions": ["change_password", "reset_password"]},
    "user_management": {"resource_types": ["posting", "role"]},
    "camera_registry": {"resource_types": ["camera"]},
    "infrastructure": {"resource_types": ["circle", "police_station", "coverage_target"]},
    "alerts": {"resource_types": ["alert"]},
    "detections": {"resource_types": ["detection"]},
}

_KNOWN_ACTIONS = {a for c in CATEGORIES.values() for a in c.get("actions", [])}
_KNOWN_RESOURCE_TYPES = {rt for c in CATEGORIES.values() for rt in c.get("resource_types", [])}


def categorize(action: str, resource_type: str) -> str:
    for name, rule in CATEGORIES.items():
        if action in rule.get("actions", ()) or resource_type in rule.get("resource_types", ()):
            return name
    return "other"


def list_logs(
    conn,
    badge_number: str | None = None,
    resource_type: str | None = None,
    category: str | None = None,
    camera_id: int | None = None,
    camera_district: str | None = None,
    camera_circle_id: int | None = None,
    date_from=None,
    date_to=None,
    district: str | None = None,
    cursor: int | None = None,
    limit: int = 50,
) -> tuple[list[dict], int | None]:
    # Clamp defensively even though the route also constrains this with
    # ge=1, le=200 -- mirrors cameras_service.list_cameras_page's server-side
    # cap so this function is safe to call directly (e.g. from a script or
    # future caller) without relying on FastAPI's query validation.
    limit = max(1, min(limit, 200))
    clauses = []
    params: list = []

    # Enrichment joins -- always present, always LEFT so an entry whose
    # resource was since deleted (e.g. a test camera cleaned out of the
    # registry) still shows up, just without a resolved name -- an audit
    # trail must never lose a row because the thing it refers to is gone.
    joins = """
        LEFT JOIN officers actor_officer ON actor_officer.badge_number = audit_logs.badge_number
        LEFT JOIN cameras cam ON audit_logs.resource_type = 'camera' AND audit_logs.resource_id = cam.id
        LEFT JOIN circles circ ON cam.circle_id = circ.id
    """

    if district is not None:
        # Scope to actors whose CURRENTLY active posting is in this district
        # -- a separate INNER join pair from the enrichment LEFT JOIN above
        # (different alias) since scoping must exclude non-matching actors,
        # while the enrichment join must never exclude a row just because
        # the actor has no current posting (e.g. "ml-anpr").
        joins += """
            JOIN officers scope_officer ON scope_officer.badge_number = audit_logs.badge_number
            JOIN postings scope_posting ON scope_posting.officer_id = scope_officer.id AND scope_posting.is_active
        """
        clauses.append("scope_posting.scope_value = %s")
        params.append(district)
    if badge_number is not None:
        clauses.append("audit_logs.badge_number = %s")
        params.append(badge_number)
    if resource_type is not None:
        clauses.append("audit_logs.resource_type = %s")
        params.append(resource_type)
    if category is not None:
        rule = CATEGORIES.get(category)
        if rule is not None:
            actions = rule.get("actions")
            resource_types = rule.get("resource_types")
            if actions:
                clauses.append("audit_logs.action = ANY(%s)")
                params.append(actions)
            if resource_types:
                clauses.append("audit_logs.resource_type = ANY(%s)")
                params.append(resource_types)
        else:  # category == "other" (or an unrecognized value, treated the same)
            clauses.append("NOT (audit_logs.action = ANY(%s) OR audit_logs.resource_type = ANY(%s))")
            params.append(list(_KNOWN_ACTIONS))
            params.append(list(_KNOWN_RESOURCE_TYPES))
    # camera_id/camera_district/camera_circle_id all rely on the `cam` LEFT
    # JOIN above -- a non-camera row has cam.* as NULL, which never equals
    # anything, so these naturally narrow to camera-resource rows without
    # an explicit resource_type='camera' clause.
    if camera_id is not None:
        clauses.append("cam.id = %s")
        params.append(camera_id)
    if camera_district is not None:
        clauses.append("cam.dept = %s")
        params.append(camera_district)
    if camera_circle_id is not None:
        clauses.append("cam.circle_id = %s")
        params.append(camera_circle_id)
    if date_from is not None:
        clauses.append("audit_logs.timestamp >= %s")
        params.append(date_from)
    if date_to is not None:
        clauses.append("audit_logs.timestamp <= %s")
        params.append(date_to)
    if cursor is not None:
        clauses.append("audit_logs.id > %s")
        params.append(cursor)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT audit_logs.id, audit_logs.badge_number, audit_logs.action,
                   audit_logs.resource_type, audit_logs.resource_id,
                   audit_logs.reason_code, audit_logs.timestamp,
                   actor_officer.name, cam.name, cam.dept, circ.name
            FROM audit_logs {joins} {where}
            ORDER BY audit_logs.id
            LIMIT %s
            """,
            (*params, limit + 1),
        )
        rows = cur.fetchall()

    has_more = len(rows) > limit
    page = rows[:limit]
    next_cursor = page[-1][0] if has_more else None
    logs = [
        {
            "id": r[0], "badge_number": r[1], "action": r[2],
            "resource_type": r[3], "resource_id": r[4],
            "reason_code": r[5], "timestamp": r[6],
            "category": categorize(r[2], r[3]),
            "actor_name": r[7],
            "camera_name": r[8], "camera_district": r[9], "camera_area": r[10],
        }
        for r in page
    ]
    return logs, next_cursor
