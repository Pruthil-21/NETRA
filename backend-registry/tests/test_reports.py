def test_reports_summary_requires_auth(client):
    resp = client.get("/reports/summary")
    assert resp.status_code == 401


def test_reports_summary_shape(client, viewer_headers):
    resp = client.get("/reports/summary", headers=viewer_headers)
    assert resp.status_code == 200
    body = resp.json()

    assert body["total_cameras"] >= 1
    assert isinstance(body["cameras_by_department"], dict)
    assert isinstance(body["cameras_by_connectivity_status"], dict)
    assert isinstance(body["cameras_by_health_status"], dict)
    assert sum(body["cameras_by_department"].values()) == body["total_cameras"]
    assert sum(body["cameras_by_connectivity_status"].values()) == body["total_cameras"]
    assert sum(body["cameras_by_health_status"].values()) == body["total_cameras"]

    # alerts/detections live in backend-watchlist's schema — present as an
    # int when that schema is applied, null otherwise, but never missing.
    assert "alerts_last_24h" in body
    assert "detections_last_24h" in body
