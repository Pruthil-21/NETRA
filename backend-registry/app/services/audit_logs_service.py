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
    "credentials": {
        "actions": [
            "change_password", "reset_password", "request_password_reset", "reject_password_reset",
            "self_service_password_reset", "update_email",
        ],
    },
    # resource_type "officer" and "duty" both belong here alongside
    # posting/role -- the whole officer lifecycle (self_register through
    # approve/reject/suspend/reactivate/force_logout/unlock) and duty
    # scheduling are the same "who's allowed to do what, on what shift" concern
    # as posting/role assignment, not a separate thing. "sod_rule" (a
    # separation-of-duties rule) is the same role/permission-governance
    # concern too -- no live route creates these anymore, but real historical
    # rows exist and still deserve a real category, not "other".
    "user_management": {"resource_types": ["posting", "role", "officer", "duty", "sod_rule"]},
    "camera_registry": {"resource_types": ["camera"]},
    # "circle" predates the Circle -> Area rename (see git history) -- no
    # live route creates these anymore either, but the historical rows are
    # the direct predecessor of today's "area" rows, same domain.
    "infrastructure": {"resource_types": ["area", "police_station", "coverage_target", "circle"]},
    # watchlist entries are what a plate-match `alert` is generated against --
    # same operational concern, not a separate registry.
    "alerts": {"resource_types": ["alert", "traffic_alert", "watchlist"]},
    # vehicle_trace (a plate's movement-history lookup) is a read, not a
    # detection itself, but it's the same ANPR/detections surface an officer
    # filtering by "detections" is looking for.
    "detections": {"resource_types": ["detection", "vehicle_trace"]},
    "data_jobs": {"resource_types": ["import_export_job"]},
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
    camera_area_id: int | None = None,
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
        LEFT JOIN areas area ON cam.area_id = area.id
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
            actions = rule.get("actions", [])
            resource_types = rule.get("resource_types", [])
            # categorize() (used to label already-fetched rows) checks
            # categories in dict order and returns the FIRST match -- a row
            # with action="login", resource_type="officer" is "authentication"
            # even though "officer" also sits in user_management's
            # resource_types, since authentication's action-based rule is
            # checked first. This filter has to agree, or querying by
            # category and labeling by category would disagree on the same
            # row. Only earlier categories' ACTION lists can steal a row this
            # way (an earlier category's resource_types can't -- two
            # categories claiming the same resource_type via resource_types
            # alone isn't how CATEGORIES is actually populated), so
            # excluding rows whose action is claimed by an earlier
            # action-based rule is enough to restore that agreement.
            earlier_actions = [
                a
                for name in list(CATEGORIES)[: list(CATEGORIES).index(category)]
                for a in CATEGORIES[name].get("actions", [])
            ]
            sub_clauses = []
            if actions:
                sub_clauses.append("audit_logs.action = ANY(%s)")
                params.append(actions)
            if resource_types:
                if earlier_actions:
                    sub_clauses.append("(audit_logs.resource_type = ANY(%s) AND NOT (audit_logs.action = ANY(%s)))")
                    params.append(resource_types)
                    params.append(earlier_actions)
                else:
                    sub_clauses.append("audit_logs.resource_type = ANY(%s)")
                    params.append(resource_types)
            if sub_clauses:
                clauses.append(f"({' OR '.join(sub_clauses)})")
        else:  # category == "other" (or an unrecognized value, treated the same)
            clauses.append("NOT (audit_logs.action = ANY(%s) OR audit_logs.resource_type = ANY(%s))")
            params.append(list(_KNOWN_ACTIONS))
            params.append(list(_KNOWN_RESOURCE_TYPES))
    # camera_id/camera_district/camera_area_id all rely on the `cam` LEFT
    # JOIN above -- a non-camera row has cam.* as NULL, which never equals
    # anything, so these naturally narrow to camera-resource rows without
    # an explicit resource_type='camera' clause.
    if camera_id is not None:
        clauses.append("cam.id = %s")
        params.append(camera_id)
    if camera_district is not None:
        clauses.append("cam.dept = %s")
        params.append(camera_district)
    if camera_area_id is not None:
        clauses.append("cam.area_id = %s")
        params.append(camera_area_id)
    if date_from is not None:
        clauses.append("audit_logs.timestamp >= %s")
        params.append(date_from)
    if date_to is not None:
        clauses.append("audit_logs.timestamp <= %s")
        params.append(date_to)
    if cursor is not None:
        # Keyset pagination walking BACKWARD from the cursor (a smaller id
        # is an older row) -- matches the newest-first ORDER BY below, so
        # "load more" means "show me what's older than the last row I
        # already have", not "further into ancient history first".
        clauses.append("audit_logs.id < %s")
        params.append(cursor)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT audit_logs.id, audit_logs.badge_number, audit_logs.action,
                   audit_logs.resource_type, audit_logs.resource_id,
                   audit_logs.reason_code, audit_logs.timestamp,
                   actor_officer.name, cam.name, cam.dept, area.name
            FROM audit_logs {joins} {where}
            ORDER BY audit_logs.id DESC
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
