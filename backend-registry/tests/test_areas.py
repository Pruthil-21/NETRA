import jwt
from app.config import settings
from app.db import get_conn


def _district_command_headers(district: str):
    token = jwt.encode(
        {"sub": "dc-test", "role": "district_command", "scope_type": "district",
         "scope_value": district, "permissions": ["manage_areas"]},
        settings.jwt_secret, algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def test_create_list_get_area(client, officer_headers, area_test_rows, village_for_district):
    village_id = village_for_district("Anand")
    resp = client.post(
        "/areas", json={"name": "Area Create Test", "village_id": village_id}, headers=officer_headers
    )
    assert resp.status_code == 201
    body = resp.json()
    area_test_rows.append(body["id"])
    assert body["name"] == "Area Create Test"
    assert body["district"] == "Anand"

    list_resp = client.get("/areas", headers=officer_headers)
    assert list_resp.status_code == 200
    assert any(c["id"] == body["id"] for c in list_resp.json())

    get_resp = client.get(f"/areas/{body['id']}", headers=officer_headers)
    assert get_resp.status_code == 200
    assert get_resp.json()["name"] == "Area Create Test"


def test_create_area_requires_manage_areas_permission(client, viewer_headers, village_for_district):
    resp = client.post("/areas", json={"name": "X", "village_id": village_for_district("Anand")}, headers=viewer_headers)
    assert resp.status_code == 403


def test_duplicate_area_name_in_same_district_rejected(client, officer_headers, area_test_rows, village_for_district):
    village_id = village_for_district("Anand")
    first = client.post("/areas", json={"name": "Dup Area", "village_id": village_id}, headers=officer_headers)
    area_test_rows.append(first.json()["id"])
    second = client.post("/areas", json={"name": "Dup Area", "village_id": village_id}, headers=officer_headers)
    assert second.status_code == 409


def test_district_command_cannot_create_area_outside_own_district(client, area_test_rows, village_for_district):
    resp = client.post(
        "/areas", json={"name": "Cross-District Area", "village_id": village_for_district("Vadodara")},
        headers=_district_command_headers("Anand"),
    )
    assert resp.status_code == 403


def test_district_command_cannot_update_area_outside_own_district_even_with_matching_body(
    client, officer_headers, area_test_rows, village_for_district
):
    """Regression test for a cross-district guard bypass: a district_command
    scoped to "Anand" must not be able to PUT a area whose actual district
    is "Vadodara" by claiming district "Anand" in the request body -- the
    guard must check the area's real existing district, not just the
    body's claimed value."""
    create_resp = client.post(
        "/areas", json={"name": "Vadodara HQ Area", "village_id": village_for_district("Vadodara")}, headers=officer_headers
    )
    area_id = create_resp.json()["id"]
    area_test_rows.append(area_id)

    update_resp = client.put(
        f"/areas/{area_id}", json={"name": "Renamed Area", "village_id": village_for_district("Anand")},
        headers=_district_command_headers("Anand"),
    )
    assert update_resp.status_code == 403


def test_district_command_cannot_delete_area_outside_own_district(client, officer_headers, area_test_rows, village_for_district):
    create_resp = client.post(
        "/areas", json={"name": "Vadodara Delete Test Area", "village_id": village_for_district("Vadodara")}, headers=officer_headers
    )
    area_id = create_resp.json()["id"]
    area_test_rows.append(area_id)

    delete_resp = client.delete(f"/areas/{area_id}", headers=_district_command_headers("Anand"))
    assert delete_resp.status_code == 403


def test_delete_area_blocked_while_camera_assigned(
    client, officer_headers, area_test_rows, gap_analysis_test_cameras, village_for_district
):
    area_resp = client.post("/areas", json={"name": "In-Use Area", "village_id": village_for_district("Anand")}, headers=officer_headers)
    area_id = area_resp.json()["id"]
    area_test_rows.append(area_id)

    camera_resp = client.post(
        "/cameras",
        json={
            "name": "Area Test Camera", "dept": "Anand", "lat": 22.56, "long": 72.94,
            "camera_type": "ip", "ownership": "traffic-police", "storage_type": "nvr",
            "retention_days": 15, "area_id": area_id,
        },
        headers=officer_headers,
    )
    gap_analysis_test_cameras.append(camera_resp.json()["id"])

    delete_resp = client.delete(f"/areas/{area_id}", headers=officer_headers)
    assert delete_resp.status_code == 400


def test_update_area_district_blocked_while_camera_assigned(
    client, officer_headers, area_test_rows, gap_analysis_test_cameras, village_for_district
):
    """Mirrors test_delete_area_blocked_while_camera_assigned: changing an
    in-use area's village would leave its cameras' dept pointing at the old
    district while area_id now resolves to the new one -- the same
    corrupted cross-district state the create/update camera guards forbid."""
    area_resp = client.post("/areas", json={"name": "Move Test Area", "village_id": village_for_district("Anand")}, headers=officer_headers)
    area_id = area_resp.json()["id"]
    area_test_rows.append(area_id)

    camera_resp = client.post(
        "/cameras",
        json={
            "name": "Area Move Test Camera", "dept": "Anand", "lat": 22.56, "long": 72.94,
            "camera_type": "ip", "ownership": "traffic-police", "storage_type": "nvr",
            "retention_days": 15, "area_id": area_id,
        },
        headers=officer_headers,
    )
    gap_analysis_test_cameras.append(camera_resp.json()["id"])

    update_resp = client.put(
        f"/areas/{area_id}", json={"village_id": village_for_district("Vadodara")}, headers=officer_headers,
    )
    assert update_resp.status_code == 400


def test_update_area_district_allowed_when_unused(client, officer_headers, area_test_rows, village_for_district):
    area_resp = client.post("/areas", json={"name": "Unused Move Area", "village_id": village_for_district("Anand")}, headers=officer_headers)
    area_id = area_resp.json()["id"]
    area_test_rows.append(area_id)

    update_resp = client.put(
        f"/areas/{area_id}", json={"village_id": village_for_district("Vadodara")}, headers=officer_headers,
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["district"] == "Vadodara"


def test_areas_table_and_camera_column_exist():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'areas' ORDER BY column_name"
        )
        area_columns = {row[0] for row in cur.fetchall()}
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'cameras' AND column_name = 'area_id'"
        )
        camera_has_area_id = cur.fetchone() is not None

    assert area_columns == {"id", "name", "village_id", "created_at"}
    assert camera_has_area_id
