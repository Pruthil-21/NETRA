def test_create_and_get_police_station(client, officer_headers, police_station_test_rows):
    resp = client.post(
        "/police-stations",
        json={"name": "Navrangpura PS", "lat": 23.0338, "long": 72.5619, "district": "Traffic Police", "contact": "079-12345678"},
        headers=officer_headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    police_station_test_rows.append(body["id"])
    assert body["name"] == "Navrangpura PS"
    assert body["contact"] == "079-12345678"

    get_resp = client.get(f"/police-stations/{body['id']}", headers=officer_headers)
    assert get_resp.status_code == 200
    assert get_resp.json()["name"] == "Navrangpura PS"


def test_create_station_requires_manage_stations_permission(client):
    import jwt
    from app.config import settings

    token = jwt.encode({"sub": "no-perms", "role": "viewer"}, settings.jwt_secret, algorithm="HS256")
    resp = client.post(
        "/police-stations",
        json={"name": "X", "lat": 23.0, "long": 72.5, "district": "Traffic Police"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


def test_list_and_delete_police_station(client, officer_headers, police_station_test_rows):
    create_resp = client.post(
        "/police-stations",
        json={"name": "Delete Test PS", "lat": 23.02, "long": 72.56, "district": "Traffic Police"},
        headers=officer_headers,
    )
    station_id = create_resp.json()["id"]
    police_station_test_rows.append(station_id)

    list_resp = client.get("/police-stations", headers=officer_headers)
    assert list_resp.status_code == 200
    assert any(s["id"] == station_id for s in list_resp.json())

    delete_resp = client.delete(f"/police-stations/{station_id}", headers=officer_headers)
    assert delete_resp.status_code == 204

    get_resp = client.get(f"/police-stations/{station_id}", headers=officer_headers)
    assert get_resp.status_code == 404
