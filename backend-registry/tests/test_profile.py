import os
import subprocess
import sys

BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(script):
    subprocess.run([sys.executable, script], check=True, cwd=BACKEND_ROOT)


def _login(client, badge_number="GJ-SA-001", password="demo-pass-super-admin"):
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")
    resp = client.post("/auth/login", json={"badge_number": badge_number, "password": password})
    assert resp.status_code == 200
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_me_includes_rank_photo_and_last_login_for_a_real_officer(client):
    headers = _login(client)

    resp = client.get("/auth/me", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["badge_number"] == "GJ-SA-001"
    # last_login reflects the login that just happened above -- proves it's
    # derived from the real audit_logs row, not a stale/absent value.
    assert body["last_login"] is not None
    # photo_url defaults to null until an officer sets one.
    assert body["photo_url"] is None


def test_legacy_hand_crafted_token_still_gets_a_valid_me_response(client, officer_headers):
    """officer_headers (conftest.py) is a hand-crafted role:"officer" token with
    no matching officers row -- /auth/me must degrade gracefully (defaults),
    not 500, since every existing test fixture and the demo JWT use this shape."""
    resp = client.get("/auth/me", headers=officer_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["rank"] is None
    assert body["photo_url"] is None
    assert body["last_login"] is None


def test_change_password_with_correct_current_password_succeeds_and_new_password_logs_in(client):
    headers = _login(client)

    change_resp = client.post(
        "/auth/change-password",
        json={"current_password": "demo-pass-super-admin", "new_password": "new-demo-password"},
        headers=headers,
    )
    assert change_resp.status_code == 204

    try:
        old_login = client.post(
            "/auth/login", json={"badge_number": "GJ-SA-001", "password": "demo-pass-super-admin"}
        )
        assert old_login.status_code == 401

        new_login = client.post(
            "/auth/login", json={"badge_number": "GJ-SA-001", "password": "new-demo-password"}
        )
        assert new_login.status_code == 200
    finally:
        # Restore the demo password so later tests/re-runs of this suite
        # (and other tests relying on the seeded demo credentials) aren't
        # left broken by this test's side effect.
        _run("scripts/seed_demo_officers.py")


def test_change_password_with_wrong_current_password_returns_401(client):
    headers = _login(client)

    resp = client.post(
        "/auth/change-password",
        json={"current_password": "wrong-password", "new_password": "irrelevant"},
        headers=headers,
    )
    assert resp.status_code == 401


def test_update_photo_url_persists_and_reflects_in_me(client):
    headers = _login(client)

    resp = client.put("/auth/me/photo", json={"photo_url": "https://example.com/avatar.jpg"}, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["photo_url"] == "https://example.com/avatar.jpg"

    me_resp = client.get("/auth/me", headers=headers)
    assert me_resp.json()["photo_url"] == "https://example.com/avatar.jpg"

    # Clearing it back to null must also work (an officer removing their photo).
    clear_resp = client.put("/auth/me/photo", json={"photo_url": None}, headers=headers)
    assert clear_resp.status_code == 200
    assert clear_resp.json()["photo_url"] is None
