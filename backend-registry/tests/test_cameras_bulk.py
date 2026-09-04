VALID_CAMERA = {
    "name": "Bulk Test Camera A",
    "dept": "Traffic Police",
    "lat": 23.0225,
    "long": 72.5714,
    "camera_type": "ip",
    "ownership": "traffic-police",
    "connectivity_status": "online",
    "storage_type": "nvr",
    "retention_days": 15,
    "health_status": "healthy",
    "rtsp_url": "rtsp://demo/bulk-a",
}

INVALID_CAMERA = {
    "name": "Bulk Test Camera B",
    "dept": "Traffic Police",
    # missing lat/long/camera_type/ownership/storage_type/retention_days
}


def test_bulk_create_requires_officer(client, viewer_headers):
    resp = client.post("/cameras/bulk", json=[VALID_CAMERA], headers=viewer_headers)
    assert resp.status_code == 403


def test_bulk_create_partial_success(client, officer_headers):
    resp = client.post(
        "/cameras/bulk",
        json=[VALID_CAMERA, INVALID_CAMERA],
        headers=officer_headers,
    )
    assert resp.status_code == 200
    results = resp.json()
    assert len(results) == 2

    assert results[0]["index"] == 0
    assert results[0]["status"] == "created"
    assert results[0]["camera"]["name"] == VALID_CAMERA["name"]

    assert results[1]["index"] == 1
    assert results[1]["status"] == "error"
    assert results[1]["camera"] is None
    assert results[1]["reason"]

    created_id = results[0]["camera"]["id"]
    get_resp = client.get(f"/cameras/{created_id}", headers=officer_headers)
    assert get_resp.status_code == 200


def test_bulk_create_empty_list(client, officer_headers):
    resp = client.post("/cameras/bulk", json=[], headers=officer_headers)
    assert resp.status_code == 200
    assert resp.json() == []


def test_bulk_create_rejects_cross_district_circle(client, officer_headers, circle_test_rows):
    circle_resp = client.post(
        "/circles", json={"name": "Bulk Cross-District Circle", "district": "Vadodara"},
        headers=officer_headers,
    )
    circle_id = circle_resp.json()["id"]
    circle_test_rows.append(circle_id)

    cross_district_camera = {**VALID_CAMERA, "dept": "Anand", "circle_id": circle_id}
    resp = client.post(
        "/cameras/bulk",
        json=[cross_district_camera],
        headers=officer_headers,
    )
    assert resp.status_code == 200
    results = resp.json()
    assert len(results) == 1
    assert results[0]["status"] == "error"
    assert results[0]["camera"] is None
    assert "district" in results[0]["reason"].lower()
