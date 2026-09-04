import pytest

NEW_CAMERA = {
    "name": "Test Camera",
    "dept": "Traffic Police",
    "lat": 23.0225,
    "long": 72.5714,
    "camera_type": "ip",
    "ownership": "traffic-police",
    "connectivity_status": "online",
    "storage_type": "nvr",
    "retention_days": 15,
    "health_status": "healthy",
    "rtsp_url": "rtsp://demo/test",
}


def test_list_cameras_requires_auth(client):
    resp = client.get("/cameras")
    assert resp.status_code == 401


def test_list_cameras_with_auth(client, viewer_headers):
    resp = client.get("/cameras", headers=viewer_headers)
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
    assert len(resp.json()) > 0


def test_create_camera_requires_officer(client, viewer_headers):
    resp = client.post("/cameras", json=NEW_CAMERA, headers=viewer_headers)
    assert resp.status_code == 403


def test_camera_crud_lifecycle(client, officer_headers, viewer_headers):
    create_resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    assert create_resp.status_code == 201
    created = create_resp.json()
    camera_id = created["id"]
    assert created["name"] == NEW_CAMERA["name"]
    assert created["lat"] == pytest.approx(NEW_CAMERA["lat"], abs=1e-4)
    assert created["long"] == pytest.approx(NEW_CAMERA["long"], abs=1e-4)

    get_resp = client.get(f"/cameras/{camera_id}", headers=viewer_headers)
    assert get_resp.status_code == 200
    assert get_resp.json()["name"] == NEW_CAMERA["name"]

    update_resp = client.put(
        f"/cameras/{camera_id}",
        json={"health_status": "degraded"},
        headers=officer_headers,
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["health_status"] == "degraded"
    assert update_resp.json()["name"] == NEW_CAMERA["name"]

    delete_resp = client.delete(f"/cameras/{camera_id}", headers=officer_headers)
    assert delete_resp.status_code == 204

    missing_resp = client.get(f"/cameras/{camera_id}", headers=viewer_headers)
    assert missing_resp.status_code == 404


def test_get_missing_camera_404(client, viewer_headers):
    resp = client.get("/cameras/999999", headers=viewer_headers)
    assert resp.status_code == 404


def test_delete_missing_camera_404(client, officer_headers):
    resp = client.delete("/cameras/999999", headers=officer_headers)
    assert resp.status_code == 404


def test_create_camera_with_circle_id(client, officer_headers, circle_test_rows, gap_analysis_test_cameras):
    circle_resp = client.post(
        "/circles", json={"name": "Circle Field Test", "district": "Traffic Police"}, headers=officer_headers
    )
    circle_id = circle_resp.json()["id"]
    circle_test_rows.append(circle_id)

    camera_resp = client.post(
        "/cameras",
        json={**NEW_CAMERA, "circle_id": circle_id},
        headers=officer_headers,
    )
    assert camera_resp.status_code == 201
    camera_id = camera_resp.json()["id"]
    gap_analysis_test_cameras.append(camera_id)
    assert camera_resp.json()["circle_id"] == circle_id

    get_resp = client.get(f"/cameras/{camera_id}", headers=officer_headers)
    assert get_resp.json()["circle_id"] == circle_id


def test_create_camera_with_circle_from_different_district_rejected(
    client, officer_headers, gap_analysis_test_cameras, circle_test_rows
):
    circle_resp = client.post(
        "/circles", json={"name": "Wrong District Circle", "district": "Some Other District"}, headers=officer_headers
    )
    circle_id = circle_resp.json()["id"]
    circle_test_rows.append(circle_id)

    camera_resp = client.post(
        "/cameras", json={**NEW_CAMERA, "circle_id": circle_id}, headers=officer_headers
    )
    assert camera_resp.status_code == 400


def test_create_camera_with_missing_circle_404(client, officer_headers):
    camera_resp = client.post(
        "/cameras", json={**NEW_CAMERA, "circle_id": 999999}, headers=officer_headers
    )
    assert camera_resp.status_code == 404


def test_update_camera_circle_id(client, officer_headers, circle_test_rows, gap_analysis_test_cameras):
    """circle_id set alone, dept unchanged -- exercises the
    effective_dept = fields.get("dept", existing["dept"]) fallback branch."""
    create_resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = create_resp.json()["id"]
    gap_analysis_test_cameras.append(camera_id)

    circle_resp = client.post(
        "/circles", json={"name": "Update Circle Test", "district": NEW_CAMERA["dept"]}, headers=officer_headers
    )
    circle_id = circle_resp.json()["id"]
    circle_test_rows.append(circle_id)

    update_resp = client.put(f"/cameras/{camera_id}", json={"circle_id": circle_id}, headers=officer_headers)
    assert update_resp.status_code == 200
    assert update_resp.json()["circle_id"] == circle_id


def test_update_camera_circle_id_with_dept_change_same_request(
    client, officer_headers, circle_test_rows, gap_analysis_test_cameras
):
    """circle_id and dept set together in the same PUT -- exercises the
    effective_dept = fields["dept"] branch (the new dept, not the camera's
    existing one, is what the circle's district must match)."""
    create_resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = create_resp.json()["id"]
    gap_analysis_test_cameras.append(camera_id)

    circle_resp = client.post(
        "/circles", json={"name": "Retitled District Circle", "district": "Ahmedabad"}, headers=officer_headers
    )
    circle_id = circle_resp.json()["id"]
    circle_test_rows.append(circle_id)

    update_resp = client.put(
        f"/cameras/{camera_id}",
        json={"dept": "Ahmedabad", "circle_id": circle_id},
        headers=officer_headers,
    )
    assert update_resp.status_code == 200
    body = update_resp.json()
    assert body["circle_id"] == circle_id
    assert body["dept"] == "Ahmedabad"


def test_update_camera_circle_from_different_district_rejected(
    client, officer_headers, gap_analysis_test_cameras, circle_test_rows
):
    create_resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = create_resp.json()["id"]
    gap_analysis_test_cameras.append(camera_id)

    circle_resp = client.post(
        "/circles", json={"name": "Mismatched District Circle", "district": "Some Other District"},
        headers=officer_headers,
    )
    circle_id = circle_resp.json()["id"]
    circle_test_rows.append(circle_id)

    update_resp = client.put(f"/cameras/{camera_id}", json={"circle_id": circle_id}, headers=officer_headers)
    assert update_resp.status_code == 400


def test_update_camera_with_missing_circle_404(client, officer_headers, gap_analysis_test_cameras):
    create_resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = create_resp.json()["id"]
    gap_analysis_test_cameras.append(camera_id)

    update_resp = client.put(f"/cameras/{camera_id}", json={"circle_id": 999999}, headers=officer_headers)
    assert update_resp.status_code == 404


def test_update_camera_dept_change_alone_rejected_when_it_orphans_existing_circle_id(
    client, officer_headers, circle_test_rows, gap_analysis_test_cameras
):
    """A camera already has a circle_id whose district matches its current
    dept. A PUT that changes ONLY dept (circle_id absent from the body
    entirely) must still be validated against the camera's existing
    circle_id -- otherwise the camera ends up with a dept that no longer
    matches its circle's district."""
    circle_resp = client.post(
        "/circles", json={"name": "Dept Change Guard Circle", "district": NEW_CAMERA["dept"]},
        headers=officer_headers,
    )
    circle_id = circle_resp.json()["id"]
    circle_test_rows.append(circle_id)

    create_resp = client.post(
        "/cameras", json={**NEW_CAMERA, "circle_id": circle_id}, headers=officer_headers
    )
    camera_id = create_resp.json()["id"]
    gap_analysis_test_cameras.append(camera_id)
    assert create_resp.json()["circle_id"] == circle_id

    update_resp = client.put(
        f"/cameras/{camera_id}", json={"dept": "Some Other District"}, headers=officer_headers
    )
    assert update_resp.status_code == 400

    # the rejected update must not have partially applied -- dept and circle_id are unchanged
    get_resp = client.get(f"/cameras/{camera_id}", headers=officer_headers)
    assert get_resp.json()["dept"] == NEW_CAMERA["dept"]
    assert get_resp.json()["circle_id"] == circle_id
