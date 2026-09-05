import jwt
from app.config import settings
from app.db import get_conn


def _district_command_headers(district: str):
    token = jwt.encode(
        {"sub": "dc-test", "role": "district_command", "scope_type": "district",
         "scope_value": district, "permissions": ["manage_circles"]},
        settings.jwt_secret, algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def test_create_list_get_circle(client, officer_headers, circle_test_rows):
    resp = client.post(
        "/circles", json={"name": "Circle Create Test", "district": "Anand"}, headers=officer_headers
    )
    assert resp.status_code == 201
    body = resp.json()
    circle_test_rows.append(body["id"])
    assert body["name"] == "Circle Create Test"
    assert body["district"] == "Anand"

    list_resp = client.get("/circles", headers=officer_headers)
    assert list_resp.status_code == 200
    assert any(c["id"] == body["id"] for c in list_resp.json())

    get_resp = client.get(f"/circles/{body['id']}", headers=officer_headers)
    assert get_resp.status_code == 200
    assert get_resp.json()["name"] == "Circle Create Test"


def test_create_circle_requires_manage_circles_permission(client, viewer_headers):
    resp = client.post("/circles", json={"name": "X", "district": "Anand"}, headers=viewer_headers)
    assert resp.status_code == 403


def test_duplicate_circle_name_in_same_district_rejected(client, officer_headers, circle_test_rows):
    first = client.post("/circles", json={"name": "Dup Circle", "district": "Anand"}, headers=officer_headers)
    circle_test_rows.append(first.json()["id"])
    second = client.post("/circles", json={"name": "Dup Circle", "district": "Anand"}, headers=officer_headers)
    assert second.status_code == 409


def test_district_command_cannot_create_circle_outside_own_district(client, circle_test_rows):
    resp = client.post(
        "/circles", json={"name": "Cross-District Circle", "district": "Vadodara"},
        headers=_district_command_headers("Anand"),
    )
    assert resp.status_code == 403


def test_district_command_cannot_update_circle_outside_own_district_even_with_matching_body(
    client, officer_headers, circle_test_rows
):
    """Regression test for a cross-district guard bypass: a district_command
    scoped to "Anand" must not be able to PUT a circle whose actual district
    is "Vadodara" by claiming district "Anand" in the request body -- the
    guard must check the circle's real existing district, not just the
    body's claimed value."""
    create_resp = client.post(
        "/circles", json={"name": "Vadodara HQ Circle", "district": "Vadodara"}, headers=officer_headers
    )
    circle_id = create_resp.json()["id"]
    circle_test_rows.append(circle_id)

    update_resp = client.put(
        f"/circles/{circle_id}", json={"name": "Renamed Circle", "district": "Anand"},
        headers=_district_command_headers("Anand"),
    )
    assert update_resp.status_code == 403


def test_district_command_cannot_delete_circle_outside_own_district(client, officer_headers, circle_test_rows):
    create_resp = client.post(
        "/circles", json={"name": "Vadodara Delete Test Circle", "district": "Vadodara"}, headers=officer_headers
    )
    circle_id = create_resp.json()["id"]
    circle_test_rows.append(circle_id)

    delete_resp = client.delete(f"/circles/{circle_id}", headers=_district_command_headers("Anand"))
    assert delete_resp.status_code == 403


def test_delete_circle_blocked_while_camera_assigned(client, officer_headers, circle_test_rows, gap_analysis_test_cameras):
    circle_resp = client.post("/circles", json={"name": "In-Use Circle", "district": "Anand"}, headers=officer_headers)
    circle_id = circle_resp.json()["id"]
    circle_test_rows.append(circle_id)

    camera_resp = client.post(
        "/cameras",
        json={
            "name": "Circle Test Camera", "dept": "Anand", "lat": 22.56, "long": 72.94,
            "camera_type": "ip", "ownership": "traffic-police", "storage_type": "nvr",
            "retention_days": 15, "circle_id": circle_id,
        },
        headers=officer_headers,
    )
    gap_analysis_test_cameras.append(camera_resp.json()["id"])

    delete_resp = client.delete(f"/circles/{circle_id}", headers=officer_headers)
    assert delete_resp.status_code == 400


def test_update_circle_district_blocked_while_camera_assigned(
    client, officer_headers, circle_test_rows, gap_analysis_test_cameras
):
    """Mirrors test_delete_circle_blocked_while_camera_assigned: changing an
    in-use circle's district would leave its cameras' dept pointing at the
    old district while circle_id now resolves to the new one -- the same
    corrupted cross-district state the create/update camera guards forbid."""
    circle_resp = client.post("/circles", json={"name": "Move Test Circle", "district": "Anand"}, headers=officer_headers)
    circle_id = circle_resp.json()["id"]
    circle_test_rows.append(circle_id)

    camera_resp = client.post(
        "/cameras",
        json={
            "name": "Circle Move Test Camera", "dept": "Anand", "lat": 22.56, "long": 72.94,
            "camera_type": "ip", "ownership": "traffic-police", "storage_type": "nvr",
            "retention_days": 15, "circle_id": circle_id,
        },
        headers=officer_headers,
    )
    gap_analysis_test_cameras.append(camera_resp.json()["id"])

    update_resp = client.put(
        f"/circles/{circle_id}", json={"district": "Vadodara"}, headers=officer_headers,
    )
    assert update_resp.status_code == 400


def test_update_circle_district_allowed_when_unused(client, officer_headers, circle_test_rows):
    circle_resp = client.post("/circles", json={"name": "Unused Move Circle", "district": "Anand"}, headers=officer_headers)
    circle_id = circle_resp.json()["id"]
    circle_test_rows.append(circle_id)

    update_resp = client.put(
        f"/circles/{circle_id}", json={"district": "Vadodara"}, headers=officer_headers,
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["district"] == "Vadodara"


def test_circles_table_and_camera_column_exist():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'circles' ORDER BY column_name"
        )
        circle_columns = {row[0] for row in cur.fetchall()}
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'cameras' AND column_name = 'circle_id'"
        )
        camera_has_circle_id = cur.fetchone() is not None

    assert circle_columns == {"id", "name", "district", "created_at"}
    assert camera_has_circle_id
