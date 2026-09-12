"""Data Console (registry-side import/export, phase 1) -- filters, new
entity types, real CSV/XLSX/JSON serialization, preview counts, and job
history, on top of the pre-existing cameras/officers/audit_logs job engine."""
import json
import subprocess
import sys
from pathlib import Path

import jwt
import openpyxl
from app.config import settings
from app.db import get_conn

BACKEND_ROOT = Path(__file__).resolve().parent.parent


def _run(script):
    subprocess.run([sys.executable, script], check=True, cwd=BACKEND_ROOT)


def _token(role, permissions, sub="data-console-test"):
    return jwt.encode(
        {"sub": sub, "badge_number": f"GJ-{sub}", "role": role,
         "scope_type": "platform", "scope_value": None, "permissions": permissions},
        settings.jwt_secret, algorithm="HS256",
    )


def _headers(permissions, role="district_command"):
    return {"Authorization": f"Bearer {_token(role, permissions)}"}


_ALL_DATA_CONSOLE_PERMISSIONS = [
    "manage_cameras", "manage_users_roles", "view_audit_logs", "manage_areas", "manage_stations",
]


def _admin_headers():
    return _headers(_ALL_DATA_CONSOLE_PERMISSIONS)


def test_export_requires_the_entitys_own_permission(client, data_job_test_rows):
    only_audit = _headers(["view_audit_logs"])
    resp = client.post(
        "/admin/data-jobs?direction=export", json={"entity_type": "cameras"}, headers=only_audit
    )
    assert resp.status_code == 403

    ok = client.post(
        "/admin/data-jobs?direction=export", json={"entity_type": "audit_logs"}, headers=only_audit
    )
    assert ok.status_code == 201
    data_job_test_rows.append(ok.json()["id"])


def test_unknown_entity_type_is_a_clean_400(client):
    resp = client.post(
        "/admin/data-jobs?direction=export", json={"entity_type": "not_a_real_entity"}, headers=_admin_headers()
    )
    assert resp.status_code == 400


def test_camera_export_filters_by_district(client, gap_analysis_test_cameras, data_job_test_rows):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days) "
            "VALUES (%s, %s, ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'fixed', 'govt', 'cloud', 30) RETURNING id",
            ("Data Console Test Cam A", "Data Console District A"),
        )
        cam_a = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days) "
            "VALUES (%s, %s, ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'fixed', 'govt', 'cloud', 30) RETURNING id",
            ("Data Console Test Cam B", "Data Console District B"),
        )
        cam_b = cur.fetchone()[0]
        conn.commit()
    gap_analysis_test_cameras.append(cam_a)
    gap_analysis_test_cameras.append(cam_b)

    resp = client.post(
        "/admin/data-jobs?direction=export",
        json={"entity_type": "cameras", "filters": {"district": "Data Console District A"}},
        headers=_admin_headers(),
    )
    assert resp.status_code == 201
    body = resp.json()
    data_job_test_rows.append(body["id"])
    ids = {row["id"] for row in body["row_results"]}
    assert cam_a in ids
    assert cam_b not in ids
    assert body["total_rows"] == len(ids)


def test_preview_count_matches_the_actual_export(client, gap_analysis_test_cameras, data_job_test_rows):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days) "
            "VALUES (%s, %s, ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'fixed', 'govt', 'cloud', 30) RETURNING id",
            ("Data Console Preview Cam", "Data Console Preview District"),
        )
        cam_id = cur.fetchone()[0]
        conn.commit()
    gap_analysis_test_cameras.append(cam_id)

    filters = {"district": "Data Console Preview District"}
    preview = client.get(
        "/admin/data-jobs/preview",
        params={"entity_type": "cameras", "filters": json.dumps(filters)},
        headers=_admin_headers(),
    )
    assert preview.status_code == 200
    export = client.post(
        "/admin/data-jobs?direction=export",
        json={"entity_type": "cameras", "filters": filters},
        headers=_admin_headers(),
    )
    data_job_test_rows.append(export.json()["id"])
    assert preview.json()["count"] == export.json()["total_rows"] == 1


def test_camera_status_history_export_filters_by_camera_and_date(client, gap_analysis_test_cameras, data_job_test_rows):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days, "
            "connectivity_status) VALUES (%s, %s, ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'fixed', 'govt', "
            "'cloud', 30, 'online') RETURNING id",
            ("Data Console History Cam", "Data Console History District"),
        )
        cam_id = cur.fetchone()[0]
        conn.commit()
    gap_analysis_test_cameras.append(cam_id)

    flip = client.put(
        f"/cameras/{cam_id}", json={"connectivity_status": "offline"}, headers=_admin_headers()
    )
    assert flip.status_code == 200

    resp = client.post(
        "/admin/data-jobs?direction=export",
        json={"entity_type": "camera_status_history", "filters": {"camera_id": cam_id}},
        headers=_admin_headers(),
    )
    assert resp.status_code == 201
    data_job_test_rows.append(resp.json()["id"])
    rows = resp.json()["row_results"]
    assert any(r["connectivity_status"] == "offline" for r in rows)

    future_only = client.post(
        "/admin/data-jobs?direction=export",
        json={
            "entity_type": "camera_status_history",
            "filters": {"camera_id": cam_id, "date_from": "2999-01-01T00:00:00Z"},
        },
        headers=_admin_headers(),
    )
    data_job_test_rows.append(future_only.json()["id"])
    assert future_only.json()["row_results"] == []


def test_postings_export_includes_a_seeded_posting(client, data_job_test_rows):
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")

    resp = client.post(
        "/admin/data-jobs?direction=export",
        json={"entity_type": "postings", "filters": {"role": "district_command", "active_only": True}},
        headers=_admin_headers(),
    )
    assert resp.status_code == 201
    data_job_test_rows.append(resp.json()["id"])
    rows = resp.json()["row_results"]
    assert len(rows) >= 1
    assert all(r["role"] == "district_command" and r["is_active"] for r in rows)


def test_areas_police_stations_and_coverage_targets_export(
    client, area_test_rows, police_station_test_rows, gap_analysis_test_targets, data_job_test_rows, village_for_district
):
    district = "Data Console Reference District"
    area = client.post("/areas", json={"name": "Data Console Area", "village_id": village_for_district(district)}, headers=_admin_headers())
    area_test_rows.append(area.json()["id"])
    station = client.post(
        "/police-stations",
        json={"name": "Data Console Station", "lat": 23.0, "long": 72.5, "district": district},
        headers=_admin_headers(),
    )
    police_station_test_rows.append(station.json()["id"])
    target = client.post(
        "/coverage-targets",
        json={"name": "Data Console Target", "lat": 23.0, "long": 72.5, "district": district, "priority": "high"},
        headers=_admin_headers(),
    )
    gap_analysis_test_targets.append(target.json()["id"])

    for entity_type, created_id in (
        ("areas", area.json()["id"]),
        ("police_stations", station.json()["id"]),
        ("coverage_targets", target.json()["id"]),
    ):
        resp = client.post(
            "/admin/data-jobs?direction=export",
            json={"entity_type": entity_type, "filters": {"district": district}},
            headers=_admin_headers(),
        )
        assert resp.status_code == 201
        data_job_test_rows.append(resp.json()["id"])
        ids = {row["id"] for row in resp.json()["row_results"]}
        assert created_id in ids, f"{entity_type} export missed its own row"


def test_registration_requests_export_filters_by_status(client, data_job_test_rows):
    resp = client.post(
        "/admin/data-jobs?direction=export",
        json={"entity_type": "registration_requests", "filters": {"status": "__no_such_status__"}},
        headers=_admin_headers(),
    )
    assert resp.status_code == 201
    data_job_test_rows.append(resp.json()["id"])
    assert resp.json()["row_results"] == []


def test_audit_logs_export_pages_through_every_matching_row(client, data_job_test_rows):
    # Login is exactly the "authentication" category action -- see
    # audit_logs_service.CATEGORIES.
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")
    client.post("/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"})

    resp = client.post(
        "/admin/data-jobs?direction=export",
        json={"entity_type": "audit_logs", "filters": {"category": "authentication"}},
        headers=_admin_headers(),
    )
    assert resp.status_code == 201
    data_job_test_rows.append(resp.json()["id"])
    rows = resp.json()["row_results"]
    assert len(rows) >= 1
    assert all(r["category"] == "authentication" for r in rows)


def test_csv_download_guards_against_formula_injection(client, gap_analysis_test_cameras, data_job_test_rows):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days) "
            "VALUES (%s, %s, ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'fixed', 'govt', 'cloud', 30) RETURNING id",
            ("=cmd(danger)", "Data Console Formula District"),
        )
        cam_id = cur.fetchone()[0]
        conn.commit()
    gap_analysis_test_cameras.append(cam_id)

    job = client.post(
        "/admin/data-jobs?direction=export",
        json={"entity_type": "cameras", "format": "csv", "filters": {"district": "Data Console Formula District"}},
        headers=_admin_headers(),
    )
    job_id = job.json()["id"]
    data_job_test_rows.append(job_id)

    download = client.get(f"/admin/data-jobs/{job_id}/download", headers=_admin_headers())
    assert download.status_code == 200
    assert download.headers["content-type"].startswith("text/csv")
    assert "'=cmd(danger)" in download.text
    assert "\n=cmd(danger)" not in download.text.replace("\r\n", "\n")


def test_xlsx_download_produces_a_real_readable_workbook(client, gap_analysis_test_cameras, data_job_test_rows):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days) "
            "VALUES (%s, %s, ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'fixed', 'govt', 'cloud', 30) RETURNING id",
            ("Data Console XLSX Cam", "Data Console XLSX District"),
        )
        cam_id = cur.fetchone()[0]
        conn.commit()
    gap_analysis_test_cameras.append(cam_id)

    job = client.post(
        "/admin/data-jobs?direction=export",
        json={"entity_type": "cameras", "format": "xlsx", "filters": {"district": "Data Console XLSX District"}},
        headers=_admin_headers(),
    )
    job_id = job.json()["id"]
    data_job_test_rows.append(job_id)

    download = client.get(f"/admin/data-jobs/{job_id}/download", headers=_admin_headers())
    assert download.status_code == 200
    assert download.headers["content-type"] == (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )

    import io
    workbook = openpyxl.load_workbook(io.BytesIO(download.content))
    sheet = workbook.active
    header = [cell.value for cell in next(sheet.iter_rows(min_row=1, max_row=1))]
    assert "name" in header
    assert "dept" in header


def test_json_download_is_a_valid_json_array(client, gap_analysis_test_cameras, data_job_test_rows):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days) "
            "VALUES (%s, %s, ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'fixed', 'govt', 'cloud', 30) RETURNING id",
            ("Data Console JSON Cam", "Data Console JSON District"),
        )
        cam_id = cur.fetchone()[0]
        conn.commit()
    gap_analysis_test_cameras.append(cam_id)

    job = client.post(
        "/admin/data-jobs?direction=export",
        json={"entity_type": "cameras", "format": "json", "filters": {"district": "Data Console JSON District"}},
        headers=_admin_headers(),
    )
    job_id = job.json()["id"]
    data_job_test_rows.append(job_id)

    download = client.get(f"/admin/data-jobs/{job_id}/download", headers=_admin_headers())
    assert download.status_code == 200
    assert download.headers["content-type"].startswith("application/json")
    parsed = json.loads(download.content)
    assert any(row["id"] == cam_id for row in parsed)


def test_download_format_can_override_the_jobs_stored_format(client, gap_analysis_test_cameras, data_job_test_rows):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days) "
            "VALUES (%s, %s, ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'fixed', 'govt', 'cloud', 30) RETURNING id",
            ("Data Console Override Cam", "Data Console Override District"),
        )
        cam_id = cur.fetchone()[0]
        conn.commit()
    gap_analysis_test_cameras.append(cam_id)

    job = client.post(
        "/admin/data-jobs?direction=export",
        json={"entity_type": "cameras", "format": "json", "filters": {"district": "Data Console Override District"}},
        headers=_admin_headers(),
    )
    job_id = job.json()["id"]
    data_job_test_rows.append(job_id)

    download = client.get(
        f"/admin/data-jobs/{job_id}/download", params={"format": "csv"}, headers=_admin_headers()
    )
    assert download.headers["content-type"].startswith("text/csv")


def test_job_list_only_shows_entities_the_caller_has_permission_for(client, gap_analysis_test_cameras, data_job_test_rows):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days) "
            "VALUES (%s, %s, ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'fixed', 'govt', 'cloud', 30) RETURNING id",
            ("Data Console Joblist Cam", "Data Console Joblist District"),
        )
        cam_id = cur.fetchone()[0]
        conn.commit()
    gap_analysis_test_cameras.append(cam_id)

    admin = _admin_headers()
    cam_job = client.post("/admin/data-jobs?direction=export", json={"entity_type": "cameras"}, headers=admin)
    audit_job = client.post("/admin/data-jobs?direction=export", json={"entity_type": "audit_logs"}, headers=admin)
    data_job_test_rows.append(cam_job.json()["id"])
    data_job_test_rows.append(audit_job.json()["id"])

    audit_only = _headers(["view_audit_logs"])
    resp = client.get("/admin/data-jobs", headers=audit_only)
    assert resp.status_code == 200
    entity_types = {job["entity_type"] for job in resp.json()}
    assert "cameras" not in entity_types
    assert "audit_logs" in entity_types


def test_job_list_filtered_by_entity_type_requires_that_entitys_permission(client):
    audit_only = _headers(["view_audit_logs"])
    resp = client.get("/admin/data-jobs", params={"entity_type": "cameras"}, headers=audit_only)
    assert resp.status_code == 403
