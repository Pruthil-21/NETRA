"""Multi-role jurisdiction union (v2 spec Section 3.3, Phase B): a
multi-posted officer's effective jurisdiction is the union of every active
posting's district scope, not just one."""
import os
import subprocess
import sys
import uuid

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


def test_officer_with_two_district_postings_sees_cameras_from_both(client):
    _seed()
    admin_headers = _super_admin_headers(client)
    officers = client.get("/admin/officers", headers=admin_headers).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")  # already posted to Ahmedabad

    cam_ahmedabad = client.post(
        "/cameras",
        json={
            "name": "Multi-Scope Cam Ahmedabad", "dept": "Ahmedabad", "lat": 23.02, "long": 72.57,
            "camera_type": "Fixed", "ownership": "Test", "storage_type": "Cloud", "retention_days": 30,
        },
        headers=admin_headers,
    ).json()
    cam_anand = client.post(
        "/cameras",
        json={
            "name": "Multi-Scope Cam Anand", "dept": "Anand", "lat": 22.56, "long": 72.95,
            "camera_type": "Fixed", "ownership": "Test", "storage_type": "Cloud", "retention_days": 30,
        },
        headers=admin_headers,
    ).json()
    try:
        client.post(
            "/admin/postings",
            json={"officer_id": target["id"], "role_name": "station_officer", "scope_type": "district", "scope_value": "Anand"},
            headers=admin_headers,
        )

        login_resp = client.post(
            "/auth/login", json={"badge_number": "GJ-SO-001", "password": "demo-pass-station-officer"}
        )
        officer_headers = {"Authorization": f"Bearer {login_resp.json()['token']}"}

        cameras = client.get("/cameras", headers=officer_headers).json()
        camera_ids = {c["id"] for c in cameras}
        assert cam_ahmedabad["id"] in camera_ids
        assert cam_anand["id"] in camera_ids
    finally:
        client.delete(f"/cameras/{cam_ahmedabad['id']}", headers=admin_headers)
        client.delete(f"/cameras/{cam_anand['id']}", headers=admin_headers)


def test_a_pending_officer_with_zero_postings_sees_no_cameras(client):
    _seed()
    badge = f"GJ-REG-{uuid.uuid4().hex[:8]}"
    try:
        reg_resp = client.post(
            "/auth/register",
            json={"badge_number": badge, "name": "Zero Jurisdiction", "password": "zero-jur-pass-1"},
        )
        assert reg_resp.status_code == 201

        login_resp = client.post("/auth/login", json={"badge_number": badge, "password": "zero-jur-pass-1"})
        headers = {"Authorization": f"Bearer {login_resp.json()['token']}"}

        assert client.get("/cameras", headers=headers).json() == []
        assert client.get("/circles", headers=headers).json() == []
    finally:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM officers WHERE badge_number = %s", (badge,))
            conn.commit()
