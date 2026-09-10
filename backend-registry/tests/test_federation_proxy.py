"""Tests for the DIGDHRISHTI Federation camera-inventory proxy
(app/federation_proxy.py). The federation service itself is never actually
called -- every test injects an httpx.MockTransport standing in for it, so
these only exercise our own permission/district-filtering logic and the
mapping it does against the real `cameras` table."""
import contextlib

import httpx
import psycopg
import pytest
from app.config import settings
from app.db import get_conn
from app.federation_proxy import build_router
from fastapi import FastAPI
from fastapi.testclient import TestClient
from psycopg.rows import dict_row


def _has_permission(user, permission):
    return permission in user.get("permissions", [])


def _make_client(user, handler, get_conn_fn=None):
    def get_current_user():
        return user

    app = FastAPI()
    app.include_router(
        build_router(get_current_user, _has_permission, get_conn_fn or get_conn, transport=httpx.MockTransport(handler))
    )
    return TestClient(app)


def _insert_camera(name: str, dept: str) -> int:
    with contextlib.closing(psycopg.connect(settings.database_url)) as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days)
            VALUES (%s, %s, ST_SetSRID(ST_MakePoint(72.5, 23.0), 4326), 'fixed', 'govt', 'cloud', 30)
            RETURNING id
            """,
            (name, dept),
        )
        camera_id = cur.fetchone()["id"]
        conn.commit()
    return camera_id


@pytest.fixture
def federation_test_cameras():
    created_ids: list[int] = []
    yield created_ids
    if created_ids:
        with contextlib.closing(psycopg.connect(settings.database_url)) as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM cameras WHERE id = ANY(%s)", (created_ids,))
            conn.commit()


@pytest.fixture(autouse=True)
def _federation_env(monkeypatch):
    monkeypatch.setenv("FEDERATION_URL", "http://federation.test")
    monkeypatch.setenv("FEDERATION_SERVICE_KEY", "test-service-key")


def _cameras_page(items):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["X-Service-Key"] == "test-service-key"
        return httpx.Response(200, json={"items": items, "next_cursor": None})
    return handler


def test_cameras_requires_view_live_feeds_permission():
    client = _make_client({"permissions": []}, _cameras_page([]))
    resp = client.get("/federation/cameras")
    assert resp.status_code == 403


def test_platform_user_sees_mapped_and_unmapped_cameras(federation_test_cameras):
    cam = _insert_camera("Fed Test Cam A", "Ahmedabad")
    federation_test_cameras.append(cam)
    items = [
        {"registry_camera_id": cam, "external_id": "cam-a"},
        {"registry_camera_id": None, "external_id": "unmapped-1"},
    ]
    user = {"scope_type": "platform", "permissions": ["view_live_feeds", "manage_cameras"]}
    client = _make_client(user, _cameras_page(items))

    resp = client.get("/federation/cameras")
    assert resp.status_code == 200
    ids = {row["external_id"] for row in resp.json()["items"]}
    assert ids == {"cam-a", "unmapped-1"}


def test_district_user_without_manage_cameras_never_sees_unmapped_cameras(federation_test_cameras):
    cam = _insert_camera("Fed Test Cam B", "Ahmedabad")
    federation_test_cameras.append(cam)
    items = [
        {"registry_camera_id": cam, "external_id": "cam-b"},
        {"registry_camera_id": None, "external_id": "unmapped-2"},
    ]
    user = {"scope_type": "district", "scope_value": "Ahmedabad", "permissions": ["view_live_feeds"]}
    client = _make_client(user, _cameras_page(items))

    resp = client.get("/federation/cameras")
    ids = {row["external_id"] for row in resp.json()["items"]}
    assert ids == {"cam-b"}


def test_single_district_user_only_sees_their_own_district(federation_test_cameras):
    cam_a = _insert_camera("Fed Test Cam C", "Ahmedabad")
    cam_b = _insert_camera("Fed Test Cam D", "Anand")
    federation_test_cameras += [cam_a, cam_b]
    items = [
        {"registry_camera_id": cam_a, "external_id": "cam-c"},
        {"registry_camera_id": cam_b, "external_id": "cam-d"},
    ]
    user = {"scope_type": "district", "scope_value": "Ahmedabad", "permissions": ["view_live_feeds"]}
    client = _make_client(user, _cameras_page(items))

    resp = client.get("/federation/cameras")
    ids = {row["external_id"] for row in resp.json()["items"]}
    assert ids == {"cam-c"}


def test_multi_district_officer_sees_cameras_from_every_one_of_their_districts(federation_test_cameras):
    # Regression for the exact bug found in review: the original proxy
    # filtered by the officer's single legacy scope_value, so an officer
    # posted to more than one district (spec Section 3.3's jurisdiction
    # union) saw only their primary district's federation cameras. `scopes`
    # (plural) is what a real multi-posting token carries -- scope_value
    # alone is deliberately left as just the primary one here, matching a
    # real token, to prove the fix reads the full union and not that field.
    cam_ahmedabad = _insert_camera("Fed Test Cam E", "Ahmedabad")
    cam_anand = _insert_camera("Fed Test Cam F", "Anand")
    cam_elsewhere = _insert_camera("Fed Test Cam G", "Junagadh")
    federation_test_cameras += [cam_ahmedabad, cam_anand, cam_elsewhere]
    items = [
        {"registry_camera_id": cam_ahmedabad, "external_id": "cam-e"},
        {"registry_camera_id": cam_anand, "external_id": "cam-f"},
        {"registry_camera_id": cam_elsewhere, "external_id": "cam-g"},
    ]
    user = {
        "scope_type": "district", "scope_value": "Ahmedabad",  # primary posting only
        "scopes": [
            {"scope_type": "district", "scope_value": "Ahmedabad"},
            {"scope_type": "district", "scope_value": "Anand"},
        ],
        "permissions": ["view_live_feeds"],
    }
    client = _make_client(user, _cameras_page(items))

    resp = client.get("/federation/cameras")
    ids = {row["external_id"] for row in resp.json()["items"]}
    assert ids == {"cam-e", "cam-f"}
    assert "cam-g" not in ids


def test_sources_requires_platform_scope_even_with_manage_cameras():
    user = {"scope_type": "district", "scope_value": "Ahmedabad", "permissions": ["manage_cameras"]}
    client = _make_client(user, lambda req: httpx.Response(200, json=[]))
    resp = client.get("/federation/sources")
    assert resp.status_code == 403


def test_sources_succeeds_for_a_platform_manage_cameras_user():
    user = {"scope_type": "platform", "permissions": ["manage_cameras"]}
    client = _make_client(user, lambda req: httpx.Response(200, json=[{"id": "organizer", "status": "connected"}]))
    resp = client.get("/federation/sources")
    assert resp.status_code == 200
    assert resp.json()[0]["id"] == "organizer"


def test_sync_rejects_a_malformed_source_id():
    user = {"scope_type": "platform", "permissions": ["manage_cameras"]}
    client = _make_client(user, lambda req: httpx.Response(200, json={}))
    resp = client.post("/federation/sources/../etc-passwd/sync")
    assert resp.status_code in (404, 422)  # not a 500 either way -- FastAPI's own path routing or our own 422 check


def test_missing_federation_config_returns_a_clean_503(monkeypatch):
    monkeypatch.delenv("FEDERATION_URL", raising=False)
    monkeypatch.delenv("FEDERATION_SERVICE_KEY", raising=False)
    user = {"scope_type": "platform", "permissions": ["manage_cameras"]}
    client = _make_client(user, lambda req: httpx.Response(200, json=[]))
    resp = client.get("/federation/sources")
    assert resp.status_code == 503


def test_mapping_rejects_a_nonexistent_registry_camera():
    user = {"scope_type": "platform", "permissions": ["manage_cameras"]}
    client = _make_client(user, lambda req: httpx.Response(200, json={}))
    resp = client.put("/federation/mappings", json={"camera_id": "organizer:1", "registry_camera_id": 999999999})
    assert resp.status_code == 404


def test_mapping_succeeds_and_forwards_the_authenticated_actor(federation_test_cameras):
    cam = _insert_camera("Fed Test Cam H", "Ahmedabad")
    federation_test_cameras.append(cam)
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True})

    user = {"scope_type": "platform", "permissions": ["manage_cameras"], "badge_number": "GJ-TEST-001"}
    client = _make_client(user, handler)
    resp = client.put("/federation/mappings", json={"camera_id": "organizer:1", "registry_camera_id": cam})
    assert resp.status_code == 200
    assert captured["body"]["actor"] == "GJ-TEST-001"
    assert captured["body"]["registry_camera_id"] == cam
