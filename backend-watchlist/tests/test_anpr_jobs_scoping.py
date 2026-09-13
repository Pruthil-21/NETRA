"""GET /anpr-jobs and GET /anpr-jobs/{id} visibility: default is "my own
submissions only"; an officer who also holds view_analytics additionally
sees every job in their district scope (platform-wide sees everything).
Mirrors test_alert_district_scoping.py's shape for a single-district rule
(a job has exactly one district, unlike an alert's dual detecting/flagging
rule)."""
import contextlib

import jwt
import psycopg2
import psycopg2.extras
import pytest
from app.config import settings


@pytest.fixture(autouse=True)
def _no_real_dispatch(monkeypatch):
    """See test_anpr_jobs.py's identical fixture -- every test here also
    creates real jobs via /anpr-jobs/archive-clip, and TestClient runs
    BackgroundTasks synchronously, so this prevents a real network call to
    whatever ANPR_PIPELINE_URL is configured in this environment."""
    from app.services import anpr_jobs_service
    monkeypatch.setattr(anpr_jobs_service.settings, "anpr_pipeline_url", "")
    monkeypatch.setattr(anpr_jobs_service.settings, "anpr_pipeline_fallback_url", "")


def _headers(badge, permissions, scope_type="platform", scope_value=None):
    token = jwt.encode(
        {
            "sub": badge, "badge_number": badge, "role": "station_officer",
            "scope_type": scope_type, "scope_value": scope_value,
            "scopes": [{"scope_type": scope_type, "scope_value": scope_value}],
            "permissions": list(permissions),
        },
        settings.jwt_secret, algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def _insert_test_camera(dept: str) -> int:
    """Creates a real, isolated camera row in a controlled department --
    same pattern as test_anpr_jobs.py/test_detections.py's helper of the
    same name. These scoping tests need precise control over which
    district a submitted job resolves to, so a fresh camera per test
    (never a hardcoded id assumed to already be in some particular
    district) is what actually makes that deterministic."""
    with contextlib.closing(psycopg2.connect(settings.database_url)) as conn, \
            conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days)
            VALUES (%s, %s, ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'fixed', 'govt', 'cloud', 30)
            RETURNING id
            """,
            ("ANPR Scoping Test Source Camera", dept),
        )
        camera_id = cur.fetchone()["id"]
        conn.commit()
        return camera_id


def _submit(client, badge, camera_id, permissions=("run_anpr_lookup",), scope_type="platform", scope_value=None):
    resp = client.post(
        "/anpr-jobs/archive-clip",
        json={"source_camera_id": camera_id, "clip_start": "2026-09-12T10:00:00Z", "clip_end": "2026-09-12T10:05:00Z"},
        headers=_headers(badge, permissions, scope_type, scope_value),
    )
    assert resp.status_code == 201
    return resp.json()["id"]


def test_an_officer_with_no_extra_permission_sees_only_their_own_jobs(client, anpr_test_jobs, scoping_test_cameras):
    cam = _insert_test_camera("ANPR Scoping Test District Own")
    scoping_test_cameras.append(cam)

    mine = _submit(client, "SCOPE-OWN-A", cam)
    theirs = _submit(client, "SCOPE-OWN-B", cam)
    anpr_test_jobs.extend([mine, theirs])

    resp = client.get("/anpr-jobs", headers=_headers("SCOPE-OWN-A", ["run_anpr_lookup"]))
    ids = [j["id"] for j in resp.json()]
    assert mine in ids
    assert theirs not in ids

    get_theirs = client.get(f"/anpr-jobs/{theirs}", headers=_headers("SCOPE-OWN-A", ["run_anpr_lookup"]))
    assert get_theirs.status_code == 404


def test_view_analytics_widens_visibility_to_the_district_scope(client, anpr_test_jobs, scoping_test_cameras):
    cam = _insert_test_camera("ANPR Scoping Test District Wide")
    scoping_test_cameras.append(cam)

    mine = _submit(client, "SCOPE-WIDE-A", cam)
    same_district = _submit(client, "SCOPE-WIDE-B", cam)
    anpr_test_jobs.extend([mine, same_district])

    resp = client.get(
        "/anpr-jobs",
        headers=_headers(
            "SCOPE-WIDE-A", ["run_anpr_lookup", "view_analytics"],
            scope_type="district", scope_value="ANPR Scoping Test District Wide",
        ),
    )
    ids = [j["id"] for j in resp.json()]
    assert mine in ids
    assert same_district in ids

    get_theirs = client.get(
        f"/anpr-jobs/{same_district}",
        headers=_headers(
            "SCOPE-WIDE-A", ["run_anpr_lookup", "view_analytics"],
            scope_type="district", scope_value="ANPR Scoping Test District Wide",
        ),
    )
    assert get_theirs.status_code == 200


def test_view_analytics_does_not_widen_visibility_outside_the_district_scope(client, anpr_test_jobs, scoping_test_cameras):
    cam_mine = _insert_test_camera("ANPR Scoping Test District Out Own")
    cam_other = _insert_test_camera("ANPR Scoping Test District Out Other")
    scoping_test_cameras.extend([cam_mine, cam_other])

    mine = _submit(client, "SCOPE-OUT-A", cam_mine)
    other_district = _submit(client, "SCOPE-OUT-B", cam_other)
    anpr_test_jobs.extend([mine, other_district])

    resp = client.get(
        "/anpr-jobs",
        headers=_headers(
            "SCOPE-OUT-A", ["run_anpr_lookup", "view_analytics"],
            scope_type="district", scope_value="ANPR Scoping Test District Out Own",
        ),
    )
    ids = [j["id"] for j in resp.json()]
    assert mine in ids
    assert other_district not in ids


def test_platform_wide_officer_with_view_analytics_sees_every_job(client, anpr_test_jobs, scoping_test_cameras):
    cam = _insert_test_camera("ANPR Scoping Test District Platform")
    scoping_test_cameras.append(cam)

    a = _submit(client, "SCOPE-PLATFORM-A", cam)
    b = _submit(client, "SCOPE-PLATFORM-B", cam)
    anpr_test_jobs.extend([a, b])

    resp = client.get(
        "/anpr-jobs",
        headers=_headers("SCOPE-PLATFORM-C", ["run_anpr_lookup", "view_analytics"]),
    )
    ids = [j["id"] for j in resp.json()]
    assert a in ids
    assert b in ids
