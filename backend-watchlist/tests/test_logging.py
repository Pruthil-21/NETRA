import logging


def test_creating_a_watchlist_entry_logs_it(client, officer_headers, caplog):
    with caplog.at_level(logging.INFO, logger="netra"):
        resp = client.post(
            "/watchlist",
            json={
                "plate_number": "GJ01LOG1234",
                "reason": "Logging test",
                "dept_flagged": "Traffic Police",
                "priority": "high",
            },
            headers=officer_headers,
        )
    assert resp.status_code == 201
    assert any("GJ01LOG1234" in r.message for r in caplog.records)


def test_a_matching_detection_logs_the_alert(client, officer_headers, internal_headers, caplog):
    watchlist_resp = client.post(
        "/watchlist",
        json={
            "plate_number": "GJ01LOG5678",
            "reason": "Logging test 2",
            "dept_flagged": "Traffic Police",
            "priority": "high",
        },
        headers=officer_headers,
    )
    assert watchlist_resp.status_code == 201

    with caplog.at_level(logging.INFO, logger="netra"):
        detection_resp = client.post(
            "/detections",
            json={"camera_id": 1, "plate_number": "GJ01LOG5678", "confidence": 0.95},
            headers=internal_headers,
        )
    assert detection_resp.status_code == 201
    assert any("GJ01LOG5678" in r.message and "alert" in r.message.lower() for r in caplog.records)


def test_status_change_logs_it(client, officer_headers, internal_headers, caplog):
    watchlist_resp = client.post(
        "/watchlist",
        json={
            "plate_number": "GJ01LOG9999",
            "reason": "Logging test 3",
            "dept_flagged": "Traffic Police",
            "priority": "high",
        },
        headers=officer_headers,
    )
    assert watchlist_resp.status_code == 201

    detection_resp = client.post(
        "/detections",
        json={"camera_id": 1, "plate_number": "GJ01LOG9999", "confidence": 0.95},
        headers=internal_headers,
    )
    alert_id = detection_resp.json()["alert"]["id"]

    with caplog.at_level(logging.INFO, logger="netra"):
        resp = client.patch(f"/alerts/{alert_id}", json={"status": "ACKNOWLEDGED"}, headers=officer_headers)
    assert resp.status_code == 200
    assert any(str(alert_id) in r.message and "ACKNOWLEDGED" in r.message for r in caplog.records)
