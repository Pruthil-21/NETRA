"""District scoping for watchlist-match alerts -- previously GET /alerts and
PATCH /alerts/{id} had zero scoping at all. The rule is deliberately dual:
an alert is visible/actionable to an officer if EITHER the detecting
camera's district OR the watchlist entry's flagging district is one of
their own -- a look-out notice stays visible to the district that issued
it wherever the plate is later spotted, not only to whoever's camera
happened to catch it."""
import uuid

import jwt
import psycopg2
import psycopg2.extras
from app.config import settings


def _direct_conn():
    conn = psycopg2.connect(settings.database_url)
    conn.autocommit = True
    return conn


def _insert_test_camera(dept: str, lat: float = 23.0, long: float = 72.5) -> int:
    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO cameras (name, dept, location, camera_type, ownership, storage_type, retention_days)
            VALUES (%s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), 'fixed', 'govt', 'cloud', 30)
            RETURNING id
            """,
            (f"Alert Scoping Test Cam ({dept})", dept, long, lat),
        )
        return cur.fetchone()["id"]


def _delete_test_camera(camera_id: int):
    with _direct_conn() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM cameras WHERE id = %s", (camera_id,))


def _seed_watchlist_and_detection(client, internal_headers, camera_id: int, dept_flagged: str):
    plate = f"GJ01AS{uuid.uuid4().hex[:4].upper()}"
    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "INSERT INTO watchlist (plate_number, reason, dept_flagged) VALUES (%s, %s, %s) RETURNING id",
            (plate, "alert scoping test", dept_flagged),
        )
    detect_resp = client.post("/detections", json={"camera_id": camera_id, "plate_number": plate}, headers=internal_headers)
    assert detect_resp.status_code == 201
    alert = detect_resp.json()["alert"]
    assert alert is not None
    return alert


def _scoped_headers(district: str, badge="ALERT-SCOPE-TEST"):
    # acknowledge_alerts is granted by default -- these tests are about
    # DISTRICT scoping (dual detecting/flagging rule), not permission
    # gating, so every actor here needs to actually be authorized to PATCH;
    # a 403 in this file should mean "wrong district," never "missing
    # permission" (see test_alerts.py for permission-gating coverage itself).
    token = jwt.encode(
        {"sub": "1", "badge_number": badge, "role": "station_officer", "scope_type": "district",
         "scope_value": district, "permissions": ["acknowledge_alerts"]},
        settings.jwt_secret, algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def test_officer_sees_an_alert_detected_in_their_own_district(client, internal_headers):
    cam = _insert_test_camera("Alert Scope District A")
    try:
        alert = _seed_watchlist_and_detection(client, internal_headers, cam, dept_flagged="Some Other District")
        listed = client.get("/alerts", headers=_scoped_headers("Alert Scope District A")).json()
        assert any(a["id"] == alert["id"] for a in listed)
    finally:
        _delete_test_camera(cam)


def test_officer_does_not_see_an_alert_neither_detected_in_nor_flagged_by_their_district(client, internal_headers):
    cam = _insert_test_camera("Alert Scope District B")
    try:
        alert = _seed_watchlist_and_detection(client, internal_headers, cam, dept_flagged="Yet Another District")
        listed = client.get("/alerts", headers=_scoped_headers("Not Involved District")).json()
        assert not any(a["id"] == alert["id"] for a in listed)
    finally:
        _delete_test_camera(cam)


def test_officer_still_sees_an_alert_their_own_district_flagged_even_when_sighted_elsewhere(client, internal_headers):
    """The dual rule's whole point: District A flags a plate, it's sighted
    on a camera in District B -- District A must still see (and be able to
    act on) that alert, same as a real look-out notice."""
    cam_in_b = _insert_test_camera("Alert Scope District B2")
    try:
        alert = _seed_watchlist_and_detection(client, internal_headers, cam_in_b, dept_flagged="Alert Scope District A2")
        listed = client.get("/alerts", headers=_scoped_headers("Alert Scope District A2")).json()
        assert any(a["id"] == alert["id"] for a in listed)
    finally:
        _delete_test_camera(cam_in_b)


def test_both_the_detecting_and_flagging_district_can_act_on_the_same_alert(client, internal_headers):
    cam_in_b = _insert_test_camera("Alert Scope District B3")
    try:
        alert = _seed_watchlist_and_detection(client, internal_headers, cam_in_b, dept_flagged="Alert Scope District A3")

        # District A3 (flagged it) can acknowledge.
        ack = client.patch(
            f"/alerts/{alert['id']}", json={"status": "ACKNOWLEDGED"}, headers=_scoped_headers("Alert Scope District A3"),
        )
        assert ack.status_code == 200

        # District B3 (detected it) can also act -- e.g. dismiss.
        dismiss = client.patch(
            f"/alerts/{alert['id']}", json={"status": "DISMISSED", "reason_code": "test"},
            headers=_scoped_headers("Alert Scope District B3", badge="ALERT-SCOPE-TEST-2"),
        )
        assert dismiss.status_code == 200
    finally:
        _delete_test_camera(cam_in_b)


def test_an_uninvolved_district_cannot_act_on_the_alert(client, internal_headers):
    cam = _insert_test_camera("Alert Scope District C")
    try:
        alert = _seed_watchlist_and_detection(client, internal_headers, cam, dept_flagged="Alert Scope District D")
        resp = client.patch(
            f"/alerts/{alert['id']}", json={"status": "ACKNOWLEDGED"}, headers=_scoped_headers("Not Involved At All"),
        )
        assert resp.status_code == 403
    finally:
        _delete_test_camera(cam)


def test_platform_scoped_officer_sees_and_can_act_on_every_alert(client, internal_headers, officer_headers):
    cam = _insert_test_camera("Alert Scope District E")
    try:
        alert = _seed_watchlist_and_detection(client, internal_headers, cam, dept_flagged="Alert Scope District F")
        listed = client.get("/alerts", headers=officer_headers).json()
        assert any(a["id"] == alert["id"] for a in listed)
        resp = client.patch(f"/alerts/{alert['id']}", json={"status": "ACKNOWLEDGED"}, headers=officer_headers)
        assert resp.status_code == 200
    finally:
        _delete_test_camera(cam)


def test_denied_cross_district_alert_action_is_itself_audited(client, internal_headers):
    cam = _insert_test_camera("Alert Scope District G")
    try:
        alert = _seed_watchlist_and_detection(client, internal_headers, cam, dept_flagged="Alert Scope District H")
        resp = client.patch(
            f"/alerts/{alert['id']}", json={"status": "ACKNOWLEDGED"},
            headers=_scoped_headers("Not Involved Either", badge="ALERT-SCOPE-AUDIT-TEST"),
        )
        assert resp.status_code == 403

        with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT action, resource_type, resource_id FROM audit_logs "
                "WHERE badge_number = 'ALERT-SCOPE-AUDIT-TEST' AND action = 'access_denied_scope' "
                "ORDER BY id DESC LIMIT 1"
            )
            row = cur.fetchone()
        assert row is not None
        assert row["resource_type"] == "alert"
        assert row["resource_id"] == alert["id"]
    finally:
        _delete_test_camera(cam)
