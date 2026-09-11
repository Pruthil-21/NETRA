"""District-scoped write guards for cameras, police stations, and coverage
targets -- areas.py already had this (_guard_area_district); cameras,
police_stations, and coverage_targets did not, until now. See
rbac_scope.py's guard_dept_in_scope and cameras.py's
_require_camera_in_scope (now also applied to get/update/delete, not just
the recordings endpoints)."""
import jwt
from app.config import settings
from app.db import get_conn


def _scoped_token(district: str, permissions=None, badge="SCOPE-TEST-DC"):
    return jwt.encode(
        {"sub": "1", "badge_number": badge, "role": "district_command", "scope_type": "district",
         "scope_value": district, "permissions": permissions or ["manage_cameras", "manage_stations"]},
        settings.jwt_secret, algorithm="HS256",
    )


def _platform_token(permissions=None, badge="SCOPE-TEST-SA"):
    return jwt.encode(
        {"sub": "1", "badge_number": badge, "role": "super_admin", "scope_type": "platform", "scope_value": None,
         "permissions": permissions or ["manage_cameras", "manage_stations"]},
        settings.jwt_secret, algorithm="HS256",
    )


def _headers(token):
    return {"Authorization": f"Bearer {token}"}


NEW_CAMERA = {
    # No "dept" here deliberately -- every test below spreads this and
    # supplies its own, since the district is exactly what's under test.
    "name": "Scoping Test Camera", "lat": 22.56, "long": 72.94,
    "camera_type": "Bullet", "ownership": "Test", "storage_type": "Cloud", "retention_days": 30,
}


# --- Cameras -----------------------------------------------------------

def test_district_scoped_officer_cannot_create_camera_outside_their_district(client):
    resp = client.post(
        "/cameras",
        json={**NEW_CAMERA, "dept": "Some Other District"},
        headers=_headers(_scoped_token("My District")),
    )
    assert resp.status_code == 403


def test_district_scoped_officer_can_create_camera_in_their_own_district(client, gap_analysis_test_cameras):
    resp = client.post(
        "/cameras",
        json={**NEW_CAMERA, "dept": "My Own District"},
        headers=_headers(_scoped_token("My Own District")),
    )
    assert resp.status_code == 201
    gap_analysis_test_cameras.append(resp.json()["id"])


def test_district_scoped_officer_cannot_update_a_camera_outside_their_district(client, gap_analysis_test_cameras):
    created = client.post("/cameras", json={**NEW_CAMERA, "dept": "Owner District"}, headers=_headers(_platform_token())).json()
    gap_analysis_test_cameras.append(created["id"])

    resp = client.put(
        f"/cameras/{created['id']}", json={"name": "Renamed"}, headers=_headers(_scoped_token("Other District")),
    )
    assert resp.status_code == 403


def test_district_scoped_officer_can_update_a_camera_in_their_own_district(client, gap_analysis_test_cameras):
    created = client.post("/cameras", json={**NEW_CAMERA, "dept": "Home District"}, headers=_headers(_platform_token())).json()
    gap_analysis_test_cameras.append(created["id"])

    resp = client.put(
        f"/cameras/{created['id']}", json={"name": "Renamed OK"}, headers=_headers(_scoped_token("Home District")),
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "Renamed OK"


def test_district_scoped_officer_cannot_move_a_camera_into_another_district(client, gap_analysis_test_cameras):
    """Owning the camera today isn't enough to reparent it into a district
    the officer doesn't also hold -- the NEW dept must be in scope too."""
    created = client.post("/cameras", json={**NEW_CAMERA, "dept": "Origin District"}, headers=_headers(_platform_token())).json()
    gap_analysis_test_cameras.append(created["id"])

    resp = client.put(
        f"/cameras/{created['id']}", json={"dept": "Destination District"}, headers=_headers(_scoped_token("Origin District")),
    )
    assert resp.status_code == 403


def test_district_scoped_officer_cannot_delete_a_camera_outside_their_district(client, gap_analysis_test_cameras):
    created = client.post("/cameras", json={**NEW_CAMERA, "dept": "Keep District"}, headers=_headers(_platform_token())).json()
    gap_analysis_test_cameras.append(created["id"])

    resp = client.delete(f"/cameras/{created['id']}", headers=_headers(_scoped_token("Other District")))
    assert resp.status_code == 403
    # Still there -- the delete must not have gone through.
    assert client.get(f"/cameras/{created['id']}", headers=_headers(_platform_token())).status_code == 200


def test_district_scoped_officer_cannot_get_a_single_camera_outside_their_district(client, gap_analysis_test_cameras):
    """Closes the gap the code's own comment used to flag as pre-existing."""
    created = client.post("/cameras", json={**NEW_CAMERA, "dept": "Private District"}, headers=_headers(_platform_token())).json()
    gap_analysis_test_cameras.append(created["id"])

    resp = client.get(f"/cameras/{created['id']}", headers=_headers(_scoped_token("Other District")))
    assert resp.status_code == 403


def test_platform_scoped_actor_can_manage_a_camera_in_any_district(client, gap_analysis_test_cameras):
    created = client.post("/cameras", json={**NEW_CAMERA, "dept": "Anywhere"}, headers=_headers(_platform_token())).json()
    gap_analysis_test_cameras.append(created["id"])
    assert client.put(f"/cameras/{created['id']}", json={"name": "Still fine"}, headers=_headers(_platform_token())).status_code == 200


def test_denied_cross_district_write_is_itself_audited(client, gap_analysis_test_cameras):
    created = client.post("/cameras", json={**NEW_CAMERA, "dept": "Audited District"}, headers=_headers(_platform_token())).json()
    gap_analysis_test_cameras.append(created["id"])

    resp = client.delete(f"/cameras/{created['id']}", headers=_headers(_scoped_token("Somewhere Else", badge="SCOPE-AUDIT-TEST")))
    assert resp.status_code == 403

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT action, resource_type, resource_id FROM audit_logs "
                "WHERE badge_number = 'SCOPE-AUDIT-TEST' AND action = 'access_denied_scope' "
                "ORDER BY id DESC LIMIT 1"
            )
            row = cur.fetchone()
    assert row is not None
    assert row[1] == "camera"
    assert row[2] == created["id"]


# --- Police stations -----------------------------------------------------

NEW_STATION = {"name": "Scoping Test Station", "lat": 22.56, "long": 72.94}


def test_district_scoped_officer_cannot_create_a_police_station_outside_their_district(client):
    resp = client.post(
        "/police-stations", json={**NEW_STATION, "district": "Elsewhere"}, headers=_headers(_scoped_token("Here")),
    )
    assert resp.status_code == 403


def test_district_scoped_officer_can_create_and_manage_a_police_station_in_their_own_district(
    client, police_station_test_rows
):
    created = client.post(
        "/police-stations", json={**NEW_STATION, "district": "Station District"}, headers=_headers(_scoped_token("Station District")),
    ).json()
    police_station_test_rows.append(created["id"])

    update_resp = client.put(
        f"/police-stations/{created['id']}", json={"name": "Renamed Station"}, headers=_headers(_scoped_token("Station District")),
    )
    assert update_resp.status_code == 200


def test_police_station_list_is_scoped_to_the_officers_district(client, police_station_test_rows):
    own = client.post(
        "/police-stations", json={**NEW_STATION, "district": "Listed District"}, headers=_headers(_platform_token()),
    ).json()
    other = client.post(
        "/police-stations", json={**NEW_STATION, "district": "Unlisted District"}, headers=_headers(_platform_token()),
    ).json()
    police_station_test_rows.extend([own["id"], other["id"]])

    listed = client.get("/police-stations", headers=_headers(_scoped_token("Listed District"))).json()
    ids = {s["id"] for s in listed}
    assert own["id"] in ids
    assert other["id"] not in ids


def test_district_scoped_officer_cannot_delete_a_police_station_outside_their_district(client, police_station_test_rows):
    created = client.post(
        "/police-stations", json={**NEW_STATION, "district": "Guarded District"}, headers=_headers(_platform_token()),
    ).json()
    police_station_test_rows.append(created["id"])

    resp = client.delete(f"/police-stations/{created['id']}", headers=_headers(_scoped_token("Somewhere Else")))
    assert resp.status_code == 403


# --- Coverage targets -----------------------------------------------------

NEW_TARGET = {"name": "Scoping Test Target", "lat": 22.56, "long": 72.94}


def test_district_scoped_officer_cannot_create_a_coverage_target_outside_their_district(client):
    resp = client.post(
        "/coverage-targets", json={**NEW_TARGET, "district": "Elsewhere"}, headers=_headers(_scoped_token("Here")),
    )
    assert resp.status_code == 403


def test_district_scoped_officer_can_create_and_manage_a_coverage_target_in_their_own_district(
    client, gap_analysis_test_targets
):
    created = client.post(
        "/coverage-targets", json={**NEW_TARGET, "district": "Target District"}, headers=_headers(_scoped_token("Target District")),
    ).json()
    gap_analysis_test_targets.append(created["id"])

    update_resp = client.put(
        f"/coverage-targets/{created['id']}", json={"priority": "high"}, headers=_headers(_scoped_token("Target District")),
    )
    assert update_resp.status_code == 200


def test_coverage_target_list_is_scoped_to_the_officers_district(client, gap_analysis_test_targets):
    own = client.post(
        "/coverage-targets", json={**NEW_TARGET, "district": "Visible District"}, headers=_headers(_platform_token()),
    ).json()
    other = client.post(
        "/coverage-targets", json={**NEW_TARGET, "district": "Hidden District"}, headers=_headers(_platform_token()),
    ).json()
    gap_analysis_test_targets.extend([own["id"], other["id"]])

    listed = client.get("/coverage-targets", headers=_headers(_scoped_token("Visible District"))).json()
    ids = {t["id"] for t in listed}
    assert own["id"] in ids
    assert other["id"] not in ids


def test_district_scoped_officer_cannot_delete_a_coverage_target_outside_their_district(client, gap_analysis_test_targets):
    created = client.post(
        "/coverage-targets", json={**NEW_TARGET, "district": "Guarded Target District"}, headers=_headers(_platform_token()),
    ).json()
    gap_analysis_test_targets.append(created["id"])

    resp = client.delete(f"/coverage-targets/{created['id']}", headers=_headers(_scoped_token("Somewhere Else")))
    assert resp.status_code == 403
