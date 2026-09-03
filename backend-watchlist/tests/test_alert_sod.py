def _create_watchlist_and_matching_detection(client, officer_headers, internal_headers, plate="GJ01SOD001"):
    client.post("/watchlist", json={"plate_number": plate, "reason": "SoD test", "dept_flagged": "Test", "priority": "high"}, headers=officer_headers)
    resp = client.post(
        "/detections",
        json={"camera_id": 1, "plate_number": plate, "confidence": 0.95},
        headers=internal_headers,
    )
    return resp.json()["alert"]["id"]


def test_same_officer_cannot_both_acknowledge_and_escalate(client, officer_headers, internal_headers):
    alert_id = _create_watchlist_and_matching_detection(client, officer_headers, internal_headers)

    ack = client.patch(f"/alerts/{alert_id}", json={"status": "ACKNOWLEDGED"}, headers=officer_headers)
    assert ack.status_code == 200

    # officer_headers' JWT sub/badge is the same identity for both calls --
    # escalating after having already acted on this alert must be blocked.
    escalate = client.patch(f"/alerts/{alert_id}", json={"status": "ESCALATED", "reason_code": "REPEAT_OFFENDER"}, headers=officer_headers)
    assert escalate.status_code == 409
    assert "separation of duty" in escalate.json()["detail"].lower()


def test_a_different_officer_can_escalate_after_the_first_acknowledged(client, officer_headers, second_officer_headers, internal_headers):
    alert_id = _create_watchlist_and_matching_detection(client, officer_headers, internal_headers, plate="GJ01SOD002")

    client.patch(f"/alerts/{alert_id}", json={"status": "ACKNOWLEDGED"}, headers=officer_headers)
    escalate = client.patch(f"/alerts/{alert_id}", json={"status": "ESCALATED", "reason_code": "REPEAT_OFFENDER"}, headers=second_officer_headers)
    assert escalate.status_code == 200


def test_dismiss_is_not_subject_to_the_sod_rule(client, officer_headers, internal_headers):
    # SoD is specifically about escalation (Section 6) -- dismissing your
    # own acknowledged alert is a normal single-officer workflow.
    alert_id = _create_watchlist_and_matching_detection(client, officer_headers, internal_headers, plate="GJ01SOD003")

    client.patch(f"/alerts/{alert_id}", json={"status": "ACKNOWLEDGED"}, headers=officer_headers)
    dismiss = client.patch(f"/alerts/{alert_id}", json={"status": "DISMISSED"}, headers=officer_headers)
    assert dismiss.status_code == 200
