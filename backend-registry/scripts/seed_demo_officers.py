# backend-registry/scripts/seed_demo_officers.py
"""Seeds one demo officer per RBAC role, each with an active posting.
Idempotent -- re-running just resets the password and posting.
Run scripts/seed_rbac.py first (roles must already exist)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.db import get_conn
from app.services import auth_service

# badge_number, name, rank, password, role_name, scope_type, scope_value
OFFICERS = [
    ("GJ-SA-001", "Demo Super Admin", "System/IT Cell", "demo-pass-super-admin", "super_admin", "platform", None),
    ("GJ-DC-001", "Demo District Command", "SP", "demo-pass-district-command", "district_command", "district", "Ahmedabad"),
    ("GJ-SO-001", "Demo Station Officer", "PI", "demo-pass-station-officer", "station_officer", "district", "Ahmedabad"),
    ("GJ-CR-001", "Demo Control Room Operator", "Civilian Staff", "demo-pass-control-room", "control_room_operator", "district", "Ahmedabad"),
    ("GJ-AU-001", "Demo Auditor", "Home Dept", "demo-pass-auditor", "auditor", "platform", None),
]


def seed():
    with get_conn() as conn:
        with conn.cursor() as cur:
            for badge, name, rank, password, role_name, scope_type, scope_value in OFFICERS:
                cur.execute("SELECT id FROM roles WHERE name = %s", (role_name,))
                role_row = cur.fetchone()
                if role_row is None:
                    raise RuntimeError(f"role '{role_name}' not seeded -- run scripts/seed_rbac.py first")
                role_id = role_row[0]

                cur.execute(
                    """
                    INSERT INTO officers (badge_number, name, rank, password_hash)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (badge_number) DO UPDATE SET password_hash = EXCLUDED.password_hash
                    RETURNING id
                    """,
                    (badge, name, rank, auth_service.hash_password(password)),
                )
                officer_id = cur.fetchone()[0]

                cur.execute(
                    "UPDATE postings SET is_active = false, ended_at = now() WHERE officer_id = %s AND is_active",
                    (officer_id,),
                )
                cur.execute(
                    """
                    INSERT INTO postings (officer_id, role_id, scope_type, scope_value, assigned_by)
                    VALUES (%s, %s, %s, %s, 'seed_demo_officers.py')
                    """,
                    (officer_id, role_id, scope_type, scope_value),
                )
        conn.commit()
    print(f"Seeded {len(OFFICERS)} demo officers with active postings.")


if __name__ == "__main__":
    seed()
