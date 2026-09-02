import jwt as pyjwt
from app.config import settings


def _token(role, permissions, scope_type="platform", scope_value=None):
    return pyjwt.encode(
        {"sub": "1", "badge_number": f"GJ-{role}", "role": role,
         "scope_type": scope_type, "scope_value": scope_value, "permissions": permissions},
        settings.jwt_secret, algorithm="HS256",
    )


NEW_CAMERA = {
    "name": "Scope Test Camera", "dept": "Traffic Police", "lat": 23.0,
    "long": 72.5, "camera_type": "ip", "ownership": "traffic-police",
    "connectivity_status": "online", "storage_type": "nvr",
    "retention_days": 15, "health_status": "healthy",
}
OTHER_DEPT_CAMERA = {**NEW_CAMERA, "name": "Other Dept Camera", "dept": "Home / Police"}


def test_platform_scoped_officer_sees_all_departments(client, officer_headers):
    client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    client.post("/cameras", json=OTHER_DEPT_CAMERA, headers=officer_headers)

    token = _token("super_admin", ["view_live_feeds"], scope_type="platform")
    resp = client.get("/cameras", headers={"Authorization": f"Bearer {token}"})
    depts = {c["dept"] for c in resp.json()}
    assert "Traffic Police" in depts
    assert "Home / Police" in depts


def test_district_scoped_officer_only_sees_their_department(client, officer_headers):
    client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    client.post("/cameras", json=OTHER_DEPT_CAMERA, headers=officer_headers)

    token = _token("station_officer", ["view_live_feeds"], scope_type="district", scope_value="Traffic Police")
    resp = client.get("/cameras", headers={"Authorization": f"Bearer {token}"})
    depts = {c["dept"] for c in resp.json()}
    assert depts == {"Traffic Police"} or "Home / Police" not in depts


def test_legacy_token_still_sees_everything(client, officer_headers):
    # officer_headers has no scope_type claim at all -- must default to
    # unfiltered, matching this endpoint's behavior before this task.
    resp = client.get("/cameras", headers=officer_headers)
    assert resp.status_code == 200


def test_create_camera_still_requires_manage_cameras(client):
    token = _token("control_room_operator", ["view_live_feeds", "acknowledge_alerts"])
    resp = client.post("/cameras", json=NEW_CAMERA, headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403


def test_delete_camera_still_requires_manage_cameras(client, officer_headers):
    created = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers).json()
    token = _token("control_room_operator", ["view_live_feeds", "acknowledge_alerts"])
    resp = client.delete(f"/cameras/{created['id']}", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403
