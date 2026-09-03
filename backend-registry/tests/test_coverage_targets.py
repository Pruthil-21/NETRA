from app.db import get_conn


def _cleanup(target_id):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM coverage_targets WHERE id = %s", (target_id,))
        conn.commit()


def test_create_and_get_coverage_target(client, officer_headers):
    resp = client.post(
        "/coverage-targets",
        json={"name": "MG Road Junction", "lat": 23.0225, "long": 72.5714, "district": "Traffic Police", "priority": "high"},
        headers=officer_headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "MG Road Junction"
    assert body["priority"] == "high"
    assert abs(body["lat"] - 23.0225) < 0.001
    assert abs(body["long"] - 72.5714) < 0.001

    get_resp = client.get(f"/coverage-targets/{body['id']}", headers=officer_headers)
    assert get_resp.status_code == 200
    assert get_resp.json()["name"] == "MG Road Junction"

    _cleanup(body["id"])


def test_create_coverage_target_requires_manage_cameras_permission(client):
    import jwt
    from app.config import settings

    token = jwt.encode({"sub": "no-perms", "role": "viewer"}, settings.jwt_secret, algorithm="HS256")
    resp = client.post(
        "/coverage-targets",
        json={"name": "X", "lat": 23.0, "long": 72.5, "district": "Traffic Police"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


def test_list_coverage_targets(client, officer_headers):
    create_resp = client.post(
        "/coverage-targets",
        json={"name": "List Test Target", "lat": 23.01, "long": 72.55, "district": "Traffic Police"},
        headers=officer_headers,
    )
    target_id = create_resp.json()["id"]

    list_resp = client.get("/coverage-targets", headers=officer_headers)
    assert list_resp.status_code == 200
    assert any(t["id"] == target_id for t in list_resp.json())

    _cleanup(target_id)


def test_update_and_delete_coverage_target(client, officer_headers):
    create_resp = client.post(
        "/coverage-targets",
        json={"name": "Update Test", "lat": 23.02, "long": 72.56, "district": "Traffic Police"},
        headers=officer_headers,
    )
    target_id = create_resp.json()["id"]

    update_resp = client.put(
        f"/coverage-targets/{target_id}",
        json={"priority": "low"},
        headers=officer_headers,
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["priority"] == "low"

    delete_resp = client.delete(f"/coverage-targets/{target_id}", headers=officer_headers)
    assert delete_resp.status_code == 204

    get_resp = client.get(f"/coverage-targets/{target_id}", headers=officer_headers)
    assert get_resp.status_code == 404
