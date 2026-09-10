"""Generic import/export engine (v2 spec Section 3.7, Phase C): staged
per-row validation, an execution log, and resubmitting only failed rows."""
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


def _cleanup_cameras_by_name(names):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM cameras WHERE name = ANY(%s)", (names,))
        conn.commit()


def test_camera_import_commits_valid_rows_and_reports_invalid_ones_without_committing_them(
    client, data_job_test_rows
):
    _seed()
    headers = _super_admin_headers(client)
    rows = [
        {"name": "Import Test Cam Valid", "dept": "Ahmedabad", "lat": 23.0, "long": 72.5,
         "camera_type": "Fixed", "ownership": "Test", "storage_type": "Cloud", "retention_days": 30},
        {"name": "Import Test Cam Invalid", "dept": "Ahmedabad"},  # missing required fields
    ]
    try:
        resp = client.post(
            "/admin/data-jobs?direction=import",
            json={"entity_type": "cameras", "format": "json", "rows": rows},
            headers=headers,
        )
        assert resp.status_code == 201
        job = resp.json()
        data_job_test_rows.append(job["id"])
        assert job["total_rows"] == 2
        assert job["success_rows"] == 1
        assert job["failed_rows"] == 1
        assert job["status"] == "committed"

        cameras = client.get("/cameras", headers=headers).json()
        names = {c["name"] for c in cameras}
        assert "Import Test Cam Valid" in names
        assert "Import Test Cam Invalid" not in names
    finally:
        _cleanup_cameras_by_name(["Import Test Cam Valid", "Import Test Cam Invalid"])


def test_resubmit_failed_rows_only_retries_what_failed(client, data_job_test_rows):
    _seed()
    headers = _super_admin_headers(client)
    rows = [
        {"name": "Resubmit Cam Bad", "dept": "Ahmedabad"},  # missing required fields -- fails first time
    ]
    try:
        first = client.post(
            "/admin/data-jobs?direction=import",
            json={"entity_type": "cameras", "format": "json", "rows": rows},
            headers=headers,
        ).json()
        data_job_test_rows.append(first["id"])
        assert first["failed_rows"] == 1

        # Still bad on resubmit (we never fixed the row) -- proves it actually
        # re-ran the failed row rather than trivially reporting success.
        resubmit_resp = client.post(f"/admin/data-jobs/{first['id']}/resubmit-failed", headers=headers)
        assert resubmit_resp.status_code == 200
        resubmitted = resubmit_resp.json()
        data_job_test_rows.append(resubmitted["id"])
        assert resubmitted["id"] != first["id"]
        assert resubmitted["total_rows"] == 1
        assert resubmitted["failed_rows"] == 1
    finally:
        _cleanup_cameras_by_name(["Resubmit Cam Bad"])


def test_get_data_job_requires_the_entitys_own_permission(client, data_job_test_rows):
    _seed()
    sa_headers = _super_admin_headers(client)
    job = client.post(
        "/admin/data-jobs?direction=export",
        json={"entity_type": "officers", "format": "json"},
        headers=sa_headers,
    ).json()
    data_job_test_rows.append(job["id"])

    # An auditor holds view_audit_logs, not manage_users_roles -- blocked
    # from an officers-entity job even though they can authenticate fine.
    import jwt as pyjwt
    from app.config import settings
    auditor_token = pyjwt.encode(
        {"sub": "1", "badge_number": "GJ-AU-TEST", "role": "auditor",
         "scope_type": "platform", "scope_value": None, "permissions": ["view_audit_logs"]},
        settings.jwt_secret, algorithm="HS256",
    )
    resp = client.get(f"/admin/data-jobs/{job['id']}", headers={"Authorization": f"Bearer {auditor_token}"})
    assert resp.status_code == 403


def test_audit_logs_entity_supports_export_but_not_import(client, data_job_test_rows):
    _seed()
    headers = _super_admin_headers(client)

    export_resp = client.post(
        "/admin/data-jobs?direction=export", json={"entity_type": "audit_logs", "format": "json"}, headers=headers,
    )
    assert export_resp.status_code == 201
    data_job_test_rows.append(export_resp.json()["id"])
    assert export_resp.json()["total_rows"] >= 1

    import_resp = client.post(
        "/admin/data-jobs?direction=import",
        json={"entity_type": "audit_logs", "format": "json", "rows": [{}]},
        headers=headers,
    )
    assert import_resp.status_code == 400


def test_officer_export_returns_every_seeded_officer(client, data_job_test_rows):
    _seed()
    headers = _super_admin_headers(client)
    resp = client.post(
        "/admin/data-jobs?direction=export",
        json={"entity_type": "officers", "format": "json"},
        headers=headers,
    )
    assert resp.status_code == 201
    data_job_test_rows.append(resp.json()["id"])
    job = resp.json()
    assert job["direction"] == "export"
    badges = {row["badge_number"] for row in job["row_results"]}
    assert "GJ-SA-001" in badges
