"""Append-only audit log — insert/select only, never update or delete."""


def log(conn, user_id: str, action: str, resource_type: str, resource_id=None, badge_number=None, reason_code=None):
    # Almost every call site passes user.get("badge_number", user.get("sub"))
    # as user_id -- already a real badge number -- but leaves the separate
    # badge_number= kwarg unset, which is what audit_logs_service.list_logs's
    # actor-name enrichment join actually keys on. That silently left "who
    # did this" blank for most rows (camera/area/etc CRUD) while only
    # login/registration call sites (which happened to also pass badge_number=)
    # ever resolved a name. Defaulting it to user_id here fixes every call
    # site retroactively without touching each one -- a non-officer actor
    # ("ml-anpr", "system") just fails to join to a real officer and shows
    # as its own raw string, which is still strictly better than blank.
    if badge_number is None:
        badge_number = user_id
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO audit_logs (user_id, action, resource_type, resource_id, badge_number, reason_code)
            VALUES (%s, %s, %s, %s, %s, %s)
        """, (user_id, action, resource_type, resource_id, badge_number, reason_code))
        conn.commit()
