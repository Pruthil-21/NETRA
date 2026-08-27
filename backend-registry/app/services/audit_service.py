"""Append-only audit log — insert/select only, never update or delete."""


def log(conn, user_id: str, action: str, resource_type: str, resource_id=None):
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO audit_logs (user_id, action, resource_type, resource_id)
            VALUES (%s, %s, %s, %s)
        """, (user_id, action, resource_type, resource_id))
        conn.commit()
