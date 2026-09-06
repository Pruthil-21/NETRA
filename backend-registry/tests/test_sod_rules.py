"""Generalized Separation-of-Duty rule engine (v2 spec Section 3.8, Phase
D): an admin-configurable table of role pairs that must never both be
actively held by the same officer at once, checked at posting-assignment
time (distinct from backend-watchlist's own hardcoded alert-escalation SoD
check, which this does not replace)."""
import os
import subprocess
import sys

from app.db import get_conn

BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(script):
    subprocess.run([sys.executable, script], check=True, cwd=BACKEND_ROOT)


def _seed():
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")


def _super_admin_headers(client):
    resp = client.post("/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"})
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def _cleanup(role_ids, rule_ids):
    with get_conn() as conn:
        with conn.cursor() as cur:
            if rule_ids:
                cur.execute("DELETE FROM sod_rules WHERE id = ANY(%s)", (rule_ids,))
            if role_ids:
                cur.execute("DELETE FROM postings WHERE role_id = ANY(%s)", (role_ids,))
                cur.execute("DELETE FROM roles WHERE id = ANY(%s)", (role_ids,))
        conn.commit()


def test_conflicting_role_pair_blocks_a_second_posting_for_the_same_officer(client):
    _seed()
    headers = _super_admin_headers(client)
    role_a = client.post("/admin/roles", json={"name": "sod_test_role_a", "display_name": "SoD A"}, headers=headers).json()
    role_b = client.post("/admin/roles", json={"name": "sod_test_role_b", "display_name": "SoD B"}, headers=headers).json()
    rule = client.post(
        "/admin/sod-rules",
        json={"role_a_id": role_a["id"], "role_b_id": role_b["id"], "description": "test conflict"},
        headers=headers,
    ).json()

    officers = client.get("/admin/officers", headers=headers).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-CR-001")

    try:
        first = client.post(
            "/admin/postings",
            json={"officer_id": target["id"], "role_name": "sod_test_role_a", "scope_type": "platform"},
            headers=headers,
        )
        assert first.status_code == 201

        blocked = client.post(
            "/admin/postings",
            json={"officer_id": target["id"], "role_name": "sod_test_role_b", "scope_type": "platform"},
            headers=headers,
        )
        assert blocked.status_code == 409
    finally:
        _cleanup([role_a["id"], role_b["id"]], [rule["id"]])


def test_deleting_an_sod_rule_allows_the_previously_blocked_combination(client):
    _seed()
    headers = _super_admin_headers(client)
    role_a = client.post("/admin/roles", json={"name": "sod_test_role_c", "display_name": "SoD C"}, headers=headers).json()
    role_b = client.post("/admin/roles", json={"name": "sod_test_role_d", "display_name": "SoD D"}, headers=headers).json()
    rule = client.post(
        "/admin/sod-rules", json={"role_a_id": role_a["id"], "role_b_id": role_b["id"]}, headers=headers
    ).json()

    officers = client.get("/admin/officers", headers=headers).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-AU-001")

    try:
        client.post(
            "/admin/postings",
            json={"officer_id": target["id"], "role_name": "sod_test_role_c", "scope_type": "platform"},
            headers=headers,
        )
        del_resp = client.delete(f"/admin/sod-rules/{rule['id']}", headers=headers)
        assert del_resp.status_code == 204

        now_allowed = client.post(
            "/admin/postings",
            json={"officer_id": target["id"], "role_name": "sod_test_role_d", "scope_type": "platform"},
            headers=headers,
        )
        assert now_allowed.status_code == 201
    finally:
        _cleanup([role_a["id"], role_b["id"]], [])
