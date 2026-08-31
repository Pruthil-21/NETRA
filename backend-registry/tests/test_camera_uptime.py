NEW_CAMERA = {
    "name": "Uptime Test Camera", "dept": "Traffic Police", "lat": 23.0,
    "long": 72.5, "camera_type": "ip", "ownership": "traffic-police",
    "connectivity_status": "online", "storage_type": "nvr",
    "retention_days": 15, "health_status": "healthy",
}


def test_uptime_requires_auth(client):
    resp = client.get("/cameras/1/uptime")
    assert resp.status_code == 401


def test_uptime_for_unknown_camera_returns_404(client, viewer_headers):
    resp = client.get("/cameras/999999/uptime", headers=viewer_headers)
    assert resp.status_code == 404


def test_uptime_with_no_transitions_yet_returns_empty_windows(client, officer_headers, viewer_headers):
    create_resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = create_resp.json()["id"]

    resp = client.get(f"/cameras/{camera_id}/uptime", headers=viewer_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["camera_id"] == camera_id
    assert body["current_status"] == "online"
    assert body["windows"] == []


def test_uptime_after_one_transition_has_one_closed_and_one_open_window(client, officer_headers, viewer_headers):
    create_resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = create_resp.json()["id"]

    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "offline"}, headers=officer_headers)

    resp = client.get(f"/cameras/{camera_id}/uptime", headers=viewer_headers)
    body = resp.json()
    assert body["current_status"] == "offline"
    assert len(body["windows"]) == 1
    window = body["windows"][0]
    assert window["status"] == "offline"
    assert window["to"] is None
    assert window["duration_seconds"] >= 0


def test_uptime_after_two_transitions_has_one_closed_window(client, officer_headers, viewer_headers):
    create_resp = client.post("/cameras", json=NEW_CAMERA, headers=officer_headers)
    camera_id = create_resp.json()["id"]

    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "offline"}, headers=officer_headers)
    client.put(f"/cameras/{camera_id}", json={"connectivity_status": "online"}, headers=officer_headers)

    resp = client.get(f"/cameras/{camera_id}/uptime", headers=viewer_headers)
    body = resp.json()
    windows = body["windows"]
    assert len(windows) == 2
    assert windows[0]["status"] == "offline"
    assert windows[0]["to"] is not None
    assert windows[0]["duration_seconds"] >= 0
    assert windows[1]["status"] == "online"
    assert windows[1]["to"] is None
