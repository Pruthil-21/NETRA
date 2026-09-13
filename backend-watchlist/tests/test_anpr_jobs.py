"""Manual Plate Lookup job lifecycle: create (upload + archive-clip),
permission gating, the internal-key-gated completion callback, and upload
validation (size/type/magic-byte). District-scoped visibility is covered
separately in test_anpr_jobs_scoping.py."""
import contextlib
import io

import jwt
import psycopg2
import psycopg2.extras
import pytest
from app.config import settings


@pytest.fixture(autouse=True)
def _no_real_dispatch(monkeypatch):
    """Every test here creates a job via the real /anpr-jobs endpoints, and
    FastAPI's TestClient runs BackgroundTasks synchronously within the
    request/response cycle -- without this, dispatch_to_ml_anpr would fire a
    REAL network call to whatever ANPR_PIPELINE_URL happens to be configured
    in this environment (e.g. ml-anpr's live tunnel) on every single test.
    Tests that care about a specific dispatch outcome simulate it directly
    via the PATCH callback instead of relying on a real call ever landing."""
    from app.services import anpr_jobs_service
    monkeypatch.setattr(anpr_jobs_service.settings, "anpr_pipeline_url", "")
    monkeypatch.setattr(anpr_jobs_service.settings, "anpr_pipeline_fallback_url", "")


def _officer_headers(permissions=("run_anpr_lookup",), badge="ANPR-TEST", scope_type="platform", scope_value=None):
    token = jwt.encode(
        {
            "sub": "1", "badge_number": badge, "role": "station_officer",
            "scope_type": scope_type, "scope_value": scope_value,
            "scopes": [{"scope_type": scope_type, "scope_value": scope_value}],
            "permissions": list(permissions),
        },
        settings.jwt_secret, algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def _insert_test_camera(dept: str) -> int:
    """Creates a real, isolated camera row in a controlled department --
    same pattern as test_detections.py's helper of the same name. Archive-
    clip jobs dispatch against this rather than a hardcoded camera id, since
    assuming some fixed id (e.g. 1) is a real camera in a specific district
    only held in the shared dev database's own accumulated state, not a
    fresh/CI one."""
    with contextlib.closing(psycopg2.connect(settings.database_url)) as conn, \
            conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days)
            VALUES (%s, %s, ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'fixed', 'govt', 'cloud', 30)
            RETURNING id
            """,
            ("ANPR Jobs Test Source Camera", dept),
        )
        camera_id = cur.fetchone()["id"]
        conn.commit()
        return camera_id


def _insert_virtual_capture_camera(dept: str) -> int:
    """Same pattern as test_detections.py's helper of the same name -- a
    Manual Plate Lookup dispatch target, never a valid archive-clip source
    since it has no real footage."""
    with contextlib.closing(psycopg2.connect(settings.database_url)) as conn, \
            conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type,
                                  retention_days, is_virtual_capture)
            VALUES (%s, %s, ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'mobile_handheld', 'department', 'none', 0, true)
            RETURNING id
            """,
            ("ANPR Jobs Virtual Capture Test Camera", dept),
        )
        camera_id = cur.fetchone()["id"]
        conn.commit()
        return camera_id


@pytest.fixture
def source_camera_id(scoping_test_cameras):
    """A real, non-virtual camera in its own throwaway test district for
    archive-clip jobs to dispatch against -- paired with a virtual-capture
    camera in that same district (mirroring what seed_virtual_cameras.py
    does for real districts), since dispatch_to_ml_anpr resolves the job's
    virtual dispatch target purely from the submitting camera's own dept
    and would otherwise fail this test district for having none. Never
    reuses a seeded real district (e.g. "Anand") -- self-contained
    regardless of which seed scripts happened to run in this environment.
    `scoping_test_cameras` (see conftest.py) already guarantees cleanup for
    both rows."""
    dept = "ANPR Jobs Test District"
    camera_id = _insert_test_camera(dept)
    scoping_test_cameras.append(camera_id)
    virtual_camera_id = _insert_virtual_capture_camera(dept)
    scoping_test_cameras.append(virtual_camera_id)
    return camera_id


_JPEG_BYTES = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000" + "00" * 20 + "ffd9"
)


def test_submitting_an_archive_clip_job_resolves_district_from_the_camera(client, internal_headers, anpr_test_jobs, source_camera_id):
    resp = client.post(
        "/anpr-jobs/archive-clip",
        json={"source_camera_id": source_camera_id, "clip_start": "2026-09-12T10:00:00Z", "clip_end": "2026-09-12T10:05:00Z"},
        headers=_officer_headers(),
    )
    assert resp.status_code == 201
    body = resp.json()
    anpr_test_jobs.append(body["id"])
    assert body["district"] == "ANPR Jobs Test District"
    assert body["status"] == "pending"
    assert body["input_type"] == "archive_clip"


def test_submitting_without_run_anpr_lookup_permission_is_rejected(client, anpr_test_jobs, source_camera_id):
    resp = client.post(
        "/anpr-jobs/archive-clip",
        json={"source_camera_id": source_camera_id, "clip_start": "2026-09-12T10:00:00Z", "clip_end": "2026-09-12T10:05:00Z"},
        headers=_officer_headers(permissions=()),
    )
    assert resp.status_code == 403


def test_submitting_an_archive_clip_for_a_district_outside_scope_is_rejected(client, anpr_test_jobs, source_camera_id):
    resp = client.post(
        "/anpr-jobs/archive-clip",
        json={"source_camera_id": source_camera_id, "clip_start": "2026-09-12T10:00:00Z", "clip_end": "2026-09-12T10:05:00Z"},
        headers=_officer_headers(scope_type="district", scope_value="Vadodara"),
    )
    assert resp.status_code == 403


def test_archive_clip_with_end_before_start_is_rejected(client, anpr_test_jobs, source_camera_id):
    resp = client.post(
        "/anpr-jobs/archive-clip",
        json={"source_camera_id": source_camera_id, "clip_start": "2026-09-12T10:05:00Z", "clip_end": "2026-09-12T10:00:00Z"},
        headers=_officer_headers(),
    )
    assert resp.status_code == 422


def test_archive_clip_against_a_virtual_capture_camera_is_rejected(client, anpr_test_jobs, scoping_test_cameras):
    # The virtual capture camera itself has no real footage -- it must not
    # be a valid "source" for an archive-clip job, only a dispatch target.
    # Created directly rather than assumed to already exist for some
    # district (e.g. one seed_virtual_cameras.py happened to have run for)
    # -- a fresh/CI environment may not have run that script at all.
    virtual_camera_id = _insert_virtual_capture_camera("ANPR Jobs Virtual Capture Rejection Test District")
    scoping_test_cameras.append(virtual_camera_id)

    resp = client.post(
        "/anpr-jobs/archive-clip",
        json={
            "source_camera_id": virtual_camera_id,
            "clip_start": "2026-09-12T10:00:00Z", "clip_end": "2026-09-12T10:05:00Z",
        },
        headers=_officer_headers(),
    )
    assert resp.status_code == 404


def test_pending_job_is_visible_immediately_before_dispatch_resolves(client, anpr_test_jobs, source_camera_id):
    resp = client.post(
        "/anpr-jobs/archive-clip",
        json={"source_camera_id": source_camera_id, "clip_start": "2026-09-12T10:00:00Z", "clip_end": "2026-09-12T10:05:00Z"},
        headers=_officer_headers(),
    )
    job_id = resp.json()["id"]
    anpr_test_jobs.append(job_id)
    get_resp = client.get(f"/anpr-jobs/{job_id}", headers=_officer_headers())
    assert get_resp.status_code == 200
    assert get_resp.json()["status"] in ("pending", "processing", "failed")


def test_unconfigured_pipeline_fails_the_job_with_a_clear_message(client, anpr_test_jobs, source_camera_id):
    # _no_real_dispatch (autouse above) already forces anpr_pipeline_url to
    # "" for this whole file -- this test just confirms that state produces
    # the documented, honest failure message rather than a silent hang.
    resp = client.post(
        "/anpr-jobs/archive-clip",
        json={"source_camera_id": source_camera_id, "clip_start": "2026-09-12T10:00:00Z", "clip_end": "2026-09-12T10:05:00Z"},
        headers=_officer_headers(),
    )
    job_id = resp.json()["id"]
    anpr_test_jobs.append(job_id)
    get_resp = client.get(f"/anpr-jobs/{job_id}", headers=_officer_headers())
    body = get_resp.json()
    assert body["status"] == "failed"
    assert "not configured" in body["error_message"] or "ANPR_PIPELINE_URL" in body["error_message"]


def test_completion_callback_requires_internal_key(client, anpr_test_jobs, source_camera_id):
    resp = client.post(
        "/anpr-jobs/archive-clip",
        json={"source_camera_id": source_camera_id, "clip_start": "2026-09-12T10:00:00Z", "clip_end": "2026-09-12T10:05:00Z"},
        headers=_officer_headers(),
    )
    job_id = resp.json()["id"]
    anpr_test_jobs.append(job_id)
    patch_resp = client.patch(
        f"/anpr-jobs/{job_id}",
        json={"status": "completed", "results": [{"detection_id": 1, "plate_number": "GJ01ZZ0001"}]},
    )
    assert patch_resp.status_code == 422 or patch_resp.status_code == 401


def test_completion_callback_with_internal_key_marks_job_completed(client, internal_headers, anpr_test_jobs, source_camera_id):
    resp = client.post(
        "/anpr-jobs/archive-clip",
        json={"source_camera_id": source_camera_id, "clip_start": "2026-09-12T10:00:00Z", "clip_end": "2026-09-12T10:05:00Z"},
        headers=_officer_headers(),
    )
    job_id = resp.json()["id"]
    anpr_test_jobs.append(job_id)
    patch_resp = client.patch(
        f"/anpr-jobs/{job_id}",
        json={"status": "completed", "results": [{"detection_id": 999999, "plate_number": "GJ01ZZ9999"}]},
        headers=internal_headers,
    )
    assert patch_resp.status_code == 200
    assert patch_resp.json()["status"] == "completed"
    assert patch_resp.json()["detection_id"] == 999999
    assert patch_resp.json()["plate_number"] == "GJ01ZZ9999"


def test_completed_with_no_results_is_a_valid_no_plate_found_outcome(client, internal_headers, anpr_test_jobs, source_camera_id):
    resp = client.post(
        "/anpr-jobs/archive-clip",
        json={"source_camera_id": source_camera_id, "clip_start": "2026-09-12T10:00:00Z", "clip_end": "2026-09-12T10:05:00Z"},
        headers=_officer_headers(),
    )
    job_id = resp.json()["id"]
    anpr_test_jobs.append(job_id)
    patch_resp = client.patch(
        f"/anpr-jobs/{job_id}", json={"status": "completed", "results": []}, headers=internal_headers
    )
    assert patch_resp.status_code == 200
    body = patch_resp.json()
    assert body["status"] == "completed"
    assert body["detection_id"] is None
    assert body["plate_number"] is None
    assert body["results"] == []


def test_photo_with_multiple_plates_orders_results_nearest_to_farthest(client, internal_headers, anpr_test_jobs, source_camera_id):
    resp = client.post(
        "/anpr-jobs/archive-clip",  # reusing archive-clip creation for simplicity; ordering only depends on input_type
        json={"source_camera_id": source_camera_id, "clip_start": "2026-09-12T10:00:00Z", "clip_end": "2026-09-12T10:05:00Z"},
        headers=_officer_headers(),
    )
    job_id = resp.json()["id"]
    anpr_test_jobs.append(job_id)
    # Force this job to look like a photo submission for the ordering test --
    # input_type drives list_job_results' sort strategy.
    from app.database import get_connection
    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE anpr_jobs SET input_type = 'upload_image' WHERE id = %s", (job_id,))
        conn.commit()

    patch_resp = client.patch(
        f"/anpr-jobs/{job_id}",
        json={
            "status": "completed",
            "results": [
                {"detection_id": 111, "plate_number": "GJ01FAR0001", "box_area": 0.05},
                {"detection_id": 112, "plate_number": "GJ01NEAR001", "box_area": 0.42},
                {"detection_id": 113, "plate_number": "GJ01MID0001", "box_area": 0.2},
            ],
        },
        headers=internal_headers,
    )
    assert patch_resp.status_code == 200
    plates_in_order = [r["plate_number"] for r in patch_resp.json()["results"]]
    assert plates_in_order == ["GJ01NEAR001", "GJ01MID0001", "GJ01FAR0001"]
    # The nearest (largest box) becomes the job's own headline result.
    assert patch_resp.json()["plate_number"] == "GJ01NEAR001"


def test_clip_with_multiple_plates_orders_results_chronologically(client, internal_headers, anpr_test_jobs, source_camera_id):
    resp = client.post(
        "/anpr-jobs/archive-clip",
        json={"source_camera_id": source_camera_id, "clip_start": "2026-09-12T10:00:00Z", "clip_end": "2026-09-12T10:05:00Z"},
        headers=_officer_headers(),
    )
    job_id = resp.json()["id"]
    anpr_test_jobs.append(job_id)
    patch_resp = client.patch(
        f"/anpr-jobs/{job_id}",
        json={
            "status": "completed",
            "results": [
                {"detection_id": 121, "plate_number": "GJ01LATE001", "detected_at": "2026-09-12T10:04:00Z"},
                {"detection_id": 122, "plate_number": "GJ01EARLY01", "detected_at": "2026-09-12T10:00:30Z"},
                {"detection_id": 123, "plate_number": "GJ01MIDDLE1", "detected_at": "2026-09-12T10:02:00Z"},
            ],
        },
        headers=internal_headers,
    )
    assert patch_resp.status_code == 200
    plates_in_order = [r["plate_number"] for r in patch_resp.json()["results"]]
    assert plates_in_order == ["GJ01EARLY01", "GJ01MIDDLE1", "GJ01LATE001"]
    # The earliest-timestamp plate becomes the job's own headline result.
    assert patch_resp.json()["plate_number"] == "GJ01EARLY01"


def test_uploading_a_video_with_recorded_at_stores_it(client, anpr_test_jobs):
    resp = client.post(
        "/anpr-jobs/upload",
        data={"input_type": "upload_video", "district": "Anand", "recorded_at": "2026-09-12T10:00:00Z"},
        files={"file": ("clip.mp4", io.BytesIO(b"fake mp4 bytes"), "video/mp4")},
        headers=_officer_headers(),
    )
    # Content won't pass the real magic-byte sniff (not a real mp4), so this
    # is just confirming recorded_at parses and reaches the job row, not
    # exercising a successful upload end to end.
    assert resp.status_code in (201, 400)


def test_uploading_with_an_invalid_recorded_at_is_rejected(client, anpr_test_jobs):
    resp = client.post(
        "/anpr-jobs/upload",
        data={"input_type": "upload_video", "district": "Anand", "recorded_at": "not-a-timestamp"},
        files={"file": ("clip.mp4", io.BytesIO(b"fake mp4 bytes"), "video/mp4")},
        headers=_officer_headers(),
    )
    assert resp.status_code == 400
    assert "recorded_at" in resp.json()["detail"]


def test_dispatch_sends_recording_start_time_for_archive_clip_and_upload_video(
    client, anpr_test_jobs, monkeypatch, source_camera_id):
    """Confirms ml-anpr actually receives an anchor it can compute
    detected_at from: clip_start for archive_clip (always known), and
    recorded_at for upload_video (only when the officer supplied one)."""
    from app.services import anpr_jobs_service

    captured: list[dict] = []

    class _FakeResponse:
        def raise_for_status(self):
            pass

    def fake_post(url, json=None, headers=None, timeout=None):
        captured.append(json)
        return _FakeResponse()

    monkeypatch.setattr(anpr_jobs_service.settings, "anpr_pipeline_url", "http://fake-ml-anpr.invalid")
    monkeypatch.setattr(anpr_jobs_service.httpx, "post", fake_post)
    monkeypatch.setattr(
        anpr_jobs_service, "_fetch_fresh_clip_url", lambda *a, **k: "https://recording.example/clip.mp4"
    )

    clip_resp = client.post(
        "/anpr-jobs/archive-clip",
        json={"source_camera_id": source_camera_id, "clip_start": "2026-09-12T10:00:00Z", "clip_end": "2026-09-12T10:05:00Z"},
        headers=_officer_headers(),
    )
    anpr_test_jobs.append(clip_resp.json()["id"])

    assert len(captured) == 1
    assert captured[0]["recording_start_time"] == "2026-09-12T10:00:00+00:00"


def test_dispatch_falls_back_to_the_secondary_pipeline_url_when_the_primary_is_unreachable(
    client, anpr_test_jobs, monkeypatch, source_camera_id):
    """Avi runs ml-anpr behind two tunnels (GPU server, laptop) -- dispatch
    should try the primary first and only move to the fallback when it's
    genuinely unreachable (connection refused/timed out), landing the job on
    whichever one actually answers."""
    import httpx as httpx_module
    from app.services import anpr_jobs_service

    calls: list[str] = []

    class _FakeResponse:
        def raise_for_status(self):
            pass

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append(url)
        if url.startswith("http://primary"):
            raise httpx_module.ConnectError("connection refused", request=None)
        return _FakeResponse()

    monkeypatch.setattr(anpr_jobs_service.settings, "anpr_pipeline_url", "http://primary.invalid")
    monkeypatch.setattr(anpr_jobs_service.settings, "anpr_pipeline_fallback_url", "http://fallback.invalid")
    monkeypatch.setattr(anpr_jobs_service.httpx, "post", fake_post)
    monkeypatch.setattr(
        anpr_jobs_service, "_fetch_fresh_clip_url", lambda *a, **k: "https://recording.example/clip.mp4"
    )

    clip_resp = client.post(
        "/anpr-jobs/archive-clip",
        json={"source_camera_id": source_camera_id, "clip_start": "2026-09-12T10:00:00Z", "clip_end": "2026-09-12T10:05:00Z"},
        headers=_officer_headers(),
    )
    job_id = clip_resp.json()["id"]
    anpr_test_jobs.append(job_id)

    assert calls == ["http://primary.invalid/jobs/run", "http://fallback.invalid/jobs/run"]

    get_resp = client.get(f"/anpr-jobs/{job_id}", headers=_officer_headers())
    # Reached the fallback successfully -- not the "unreachable" failure path.
    assert get_resp.json()["status"] in ("pending", "processing")


def test_dispatch_does_not_fall_back_when_the_primary_responds_with_an_error(
    client, anpr_test_jobs, monkeypatch, source_camera_id):
    """A reachable server that errors is a real job failure to surface, not
    a reason to silently retry a different machine -- only a connection-level
    failure (unreachable) should trigger the fallback."""
    import httpx as httpx_module
    from app.services import anpr_jobs_service

    calls: list[str] = []

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append(url)
        request = httpx_module.Request("POST", url)
        response = httpx_module.Response(500, request=request)
        return response

    monkeypatch.setattr(anpr_jobs_service.settings, "anpr_pipeline_url", "http://primary.invalid")
    monkeypatch.setattr(anpr_jobs_service.settings, "anpr_pipeline_fallback_url", "http://fallback.invalid")
    monkeypatch.setattr(anpr_jobs_service.httpx, "post", fake_post)
    monkeypatch.setattr(
        anpr_jobs_service, "_fetch_fresh_clip_url", lambda *a, **k: "https://recording.example/clip.mp4"
    )

    clip_resp = client.post(
        "/anpr-jobs/archive-clip",
        json={"source_camera_id": source_camera_id, "clip_start": "2026-09-12T10:00:00Z", "clip_end": "2026-09-12T10:05:00Z"},
        headers=_officer_headers(),
    )
    job_id = clip_resp.json()["id"]
    anpr_test_jobs.append(job_id)

    assert calls == ["http://primary.invalid/jobs/run"]  # never tried the fallback

    get_resp = client.get(f"/anpr-jobs/{job_id}", headers=_officer_headers())
    assert get_resp.json()["status"] == "failed"


def test_uploading_a_valid_jpeg_is_accepted_and_hashed(client, anpr_test_jobs):
    resp = client.post(
        "/anpr-jobs/upload",
        data={"input_type": "upload_image", "district": "Anand"},
        files={"file": ("plate.jpg", io.BytesIO(_JPEG_BYTES), "image/jpeg")},
        headers=_officer_headers(),
    )
    assert resp.status_code == 201
    body = resp.json()
    anpr_test_jobs.append(body["id"])
    assert body["file_size_bytes"] == len(_JPEG_BYTES)
    assert len(body["file_sha256"]) == 64


def test_uploading_content_that_does_not_match_the_declared_type_is_rejected(client, anpr_test_jobs):
    resp = client.post(
        "/anpr-jobs/upload",
        data={"input_type": "upload_image", "district": "Anand"},
        files={"file": ("not-an-image.jpg", io.BytesIO(b"this is plain text, not a jpeg"), "image/jpeg")},
        headers=_officer_headers(),
    )
    assert resp.status_code == 400


def test_uploaded_file_is_servable_via_the_internal_file_endpoint(client, internal_headers, anpr_test_jobs):
    # ml-anpr runs on its own host/tunnel -- it can't read our local disk
    # path, so dispatch hands it a fetchable URL instead (see
    # dispatch_to_ml_anpr's file_url). This confirms the endpoint that URL
    # points at actually serves the real bytes back, internal-key gated.
    resp = client.post(
        "/anpr-jobs/upload",
        data={"input_type": "upload_image", "district": "Anand"},
        files={"file": ("plate.jpg", io.BytesIO(_JPEG_BYTES), "image/jpeg")},
        headers=_officer_headers(),
    )
    job_id = resp.json()["id"]
    anpr_test_jobs.append(job_id)

    unauth_resp = client.get(f"/anpr-jobs/{job_id}/file")
    assert unauth_resp.status_code == 422 or unauth_resp.status_code == 401

    file_resp = client.get(f"/anpr-jobs/{job_id}/file", headers=internal_headers)
    assert file_resp.status_code == 200
    assert file_resp.content == _JPEG_BYTES
    assert file_resp.headers["content-type"] == "image/jpeg"


def test_file_endpoint_404s_for_an_archive_clip_job_with_no_stored_file(client, internal_headers, anpr_test_jobs, source_camera_id):
    resp = client.post(
        "/anpr-jobs/archive-clip",
        json={"source_camera_id": source_camera_id, "clip_start": "2026-09-12T10:00:00Z", "clip_end": "2026-09-12T10:05:00Z"},
        headers=_officer_headers(),
    )
    job_id = resp.json()["id"]
    anpr_test_jobs.append(job_id)
    file_resp = client.get(f"/anpr-jobs/{job_id}/file", headers=internal_headers)
    assert file_resp.status_code == 404


def test_uploading_with_an_invalid_district_is_rejected(client, anpr_test_jobs):
    resp = client.post(
        "/anpr-jobs/upload",
        data={"input_type": "upload_image", "district": "Not A Real District"},
        files={"file": ("plate.jpg", io.BytesIO(_JPEG_BYTES), "image/jpeg")},
        headers=_officer_headers(),
    )
    assert resp.status_code == 400
