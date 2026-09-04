"""Read-side for audit_logs -- every mutating action across both services
already writes here (see audit_service.log in each); this is the first
place anything reads it back."""


def list_logs(
    conn,
    badge_number: str | None = None,
    resource_type: str | None = None,
    date_from=None,
    date_to=None,
    district: str | None = None,
    cursor: int | None = None,
    limit: int = 50,
) -> tuple[list[dict], int | None]:
    clauses = []
    params: list = []
    joins = ""

    if district is not None:
        # Scope to actors whose CURRENTLY active posting is in this district.
        # An actor with no matching officer/active posting (e.g. "ml-anpr")
        # is excluded here by design -- the inner join drops it.
        joins = """
            JOIN officers o ON o.badge_number = audit_logs.badge_number
            JOIN postings p ON p.officer_id = o.id AND p.is_active
        """
        clauses.append("p.scope_value = %s")
        params.append(district)
    if badge_number is not None:
        clauses.append("audit_logs.badge_number = %s")
        params.append(badge_number)
    if resource_type is not None:
        clauses.append("audit_logs.resource_type = %s")
        params.append(resource_type)
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
                   audit_logs.reason_code, audit_logs.timestamp
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
        }
        for r in page
    ]
    return logs, next_cursor
