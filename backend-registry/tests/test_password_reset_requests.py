import os
import subprocess
import sys

BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(script):
    subprocess.run([sys.executable, script], check=True, cwd=BACKEND_ROOT)


def _login(client, badge_number, password):
    resp = client.post("/auth/login", json={"badge_number": badge_number, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()["token"]


def _seed(client):
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")


def test_officer_can_request_a_reset_and_admin_sees_their_identity_no_password_fields(client):
    _seed(client)
    so_token = _login(client, "GJ-SO-001", "demo-pass-station-officer")

    resp = client.post(
        "/auth/password-reset-requests",
        json={"reason": "Forgot my password after leave"},
        headers={"Authorization": f"Bearer {so_token}"},
    )
    assert resp.status_code == 201
    created = resp.json()
    assert created["status"] == "pending"
    assert created["badge_number"] == "GJ-SO-001"
    assert "password" not in created and "new_password" not in created

    sa_token = _login(client, "GJ-SA-001", "demo-pass-super-admin")
    listed = client.get(
        "/admin/password-reset-requests",
        params={"status": "pending"},
        headers={"Authorization": f"Bearer {sa_token}"},
    )
    assert listed.status_code == 200
    rows = listed.json()
    match = next(r for r in rows if r["id"] == created["id"])
    assert match["officer_name"] == "Demo Station Officer"
    assert match["rank"] == "PI"
    assert match["role_name"] == "station_officer"
    assert match["reason"] == "Forgot my password after leave"


def test_approving_a_request_sets_the_password_and_marks_it_approved(client):
    _seed(client)
    so_token = _login(client, "GJ-SO-001", "demo-pass-station-officer")
    created = client.post(
        "/auth/password-reset-requests", json={}, headers={"Authorization": f"Bearer {so_token}"}
    ).json()

    sa_token = _login(client, "GJ-SA-001", "demo-pass-super-admin")
    officers = client.get("/admin/officers", headers={"Authorization": f"Bearer {sa_token}"}).json()
    target = next(o for o in officers if o["badge_number"] == "GJ-SO-001")

    reset_resp = client.post(
        f"/admin/officers/{target['id']}/reset-password",
        json={"new_password": "brand-new-approved-pw-1", "request_id": created["id"]},
        headers={"Authorization": f"Bearer {sa_token}"},
    )
    assert reset_resp.status_code == 204

    new_login = client.post("/auth/login", json={"badge_number": "GJ-SO-001", "password": "brand-new-approved-pw-1"})
    assert new_login.status_code == 200

    listed = client.get(
        "/admin/password-reset-requests", headers={"Authorization": f"Bearer {sa_token}"}
    ).json()
    match = next(r for r in listed if r["id"] == created["id"])
    assert match["status"] == "approved"
    assert match["reviewed_by"] == "GJ-SA-001"


def test_rejecting_a_request_leaves_the_password_untouched(client):
    _seed(client)
    so_token = _login(client, "GJ-SO-001", "demo-pass-station-officer")
    created = client.post(
        "/auth/password-reset-requests", json={"reason": "test"}, headers={"Authorization": f"Bearer {so_token}"}
    ).json()

    sa_token = _login(client, "GJ-SA-001", "demo-pass-super-admin")
    reject_resp = client.post(
        f"/admin/password-reset-requests/{created['id']}/reject",
        json={"reason": "Could not verify identity"},
        headers={"Authorization": f"Bearer {sa_token}"},
    )
    assert reject_resp.status_code == 200
    assert reject_resp.json()["status"] == "rejected"

    # Original password still works -- rejection never touches credentials.
    still_works = client.post("/auth/login", json={"badge_number": "GJ-SO-001", "password": "demo-pass-station-officer"})
    assert still_works.status_code == 200


def test_a_reviewed_request_cannot_be_reviewed_again(client):
    _seed(client)
    so_token = _login(client, "GJ-SO-001", "demo-pass-station-officer")
    created = client.post(
        "/auth/password-reset-requests", json={}, headers={"Authorization": f"Bearer {so_token}"}
    ).json()

    sa_token = _login(client, "GJ-SA-001", "demo-pass-super-admin")
    first = client.post(
        f"/admin/password-reset-requests/{created['id']}/reject",
        json={},
        headers={"Authorization": f"Bearer {sa_token}"},
    )
    assert first.status_code == 200

    second = client.post(
        f"/admin/password-reset-requests/{created['id']}/reject",
        json={},
        headers={"Authorization": f"Bearer {sa_token}"},
    )
    assert second.status_code == 404


def test_district_command_cannot_see_or_review_requests(client):
    _seed(client)
    so_token = _login(client, "GJ-SO-001", "demo-pass-station-officer")
    created = client.post(
        "/auth/password-reset-requests", json={}, headers={"Authorization": f"Bearer {so_token}"}
    ).json()

    dc_token = _login(client, "GJ-DC-001", "demo-pass-district-command")
    listed = client.get("/admin/password-reset-requests", headers={"Authorization": f"Bearer {dc_token}"})
    assert listed.status_code == 403

    rejected = client.post(
        f"/admin/password-reset-requests/{created['id']}/reject",
        json={},
        headers={"Authorization": f"Bearer {dc_token}"},
    )
    assert rejected.status_code == 403
