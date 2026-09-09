"""Email 2FA on login, self-service password reset via email OTP, and
"remember this device" -- all opt-in on officers.email being set (see
schema.sql). Every real send goes through email_service.send_otp_email,
monkeypatched here to capture the code instead of calling Resend -- these
tests never make a real network call."""
import os
import subprocess
import sys

import jwt as pyjwt
import pytest
from app.config import settings
from app.db import get_conn
from app.services import auth_service, email_service

BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(script):
    subprocess.run([sys.executable, script], check=True, cwd=BACKEND_ROOT)


@pytest.fixture(autouse=True)
def _seed():
    _run("scripts/seed_rbac.py")
    _run("scripts/seed_demo_officers.py")


@pytest.fixture
def captured_otps(monkeypatch):
    """Replaces the real Resend call with one that records (to, code,
    purpose) -- the test reads the code back out to drive verify calls,
    exactly as an officer would read it out of their inbox."""
    sent: list[tuple[str, str, str]] = []

    def fake_send_otp_email(to, code, purpose):
        sent.append((to, code, purpose))

    monkeypatch.setattr(email_service, "send_otp_email", fake_send_otp_email)
    return sent


def _set_officer_email(badge_number: str, email: str | None):
    with get_conn() as conn:
        officer = auth_service.get_officer_by_badge(conn, badge_number)
        auth_service.set_email(conn, officer["id"], email)
    return officer["id"]


BADGE = "GJ-SA-001"
PASSWORD = "demo-pass-super-admin"


def test_login_with_no_email_on_file_is_unaffected_by_this_feature(client):
    resp = client.post("/auth/login", json={"badge_number": BADGE, "password": PASSWORD})
    assert resp.status_code == 200
    body = resp.json()
    assert body["token"] is not None
    assert body["otp_required"] is False


def test_login_with_email_on_file_requires_otp_and_sends_one(client, captured_otps):
    _set_officer_email(BADGE, "officer@example.com")
    try:
        resp = client.post("/auth/login", json={"badge_number": BADGE, "password": PASSWORD})
        assert resp.status_code == 200
        body = resp.json()
        assert body["token"] is None
        assert body["otp_required"] is True
        assert body["pending_token"] is not None
        assert captured_otps == [("officer@example.com", captured_otps[0][1], "login_2fa")]
    finally:
        _set_officer_email(BADGE, None)


def test_verify_login_otp_with_correct_code_returns_a_real_token(client, captured_otps):
    _set_officer_email(BADGE, "officer@example.com")
    try:
        login_resp = client.post("/auth/login", json={"badge_number": BADGE, "password": PASSWORD})
        pending_token = login_resp.json()["pending_token"]
        code = captured_otps[-1][1]

        resp = client.post("/auth/verify-login-otp", json={"pending_token": pending_token, "code": code})
        assert resp.status_code == 200
        token = resp.json()["token"]
        payload = pyjwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
        assert payload["badge_number"] == BADGE
        assert resp.json()["device_token"] is None
    finally:
        _set_officer_email(BADGE, None)


def test_verify_login_otp_with_wrong_code_is_rejected(client, captured_otps):
    _set_officer_email(BADGE, "officer@example.com")
    try:
        login_resp = client.post("/auth/login", json={"badge_number": BADGE, "password": PASSWORD})
        pending_token = login_resp.json()["pending_token"]

        resp = client.post("/auth/verify-login-otp", json={"pending_token": pending_token, "code": "000000"})
        assert resp.status_code == 401
    finally:
        _set_officer_email(BADGE, None)


def test_verify_login_otp_with_garbage_pending_token_is_rejected(client):
    resp = client.post("/auth/verify-login-otp", json={"pending_token": "not-a-real-token", "code": "123456"})
    assert resp.status_code == 401


def test_remembering_a_device_lets_the_next_login_skip_otp(client, captured_otps):
    _set_officer_email(BADGE, "officer@example.com")
    try:
        login_resp = client.post("/auth/login", json={"badge_number": BADGE, "password": PASSWORD})
        pending_token = login_resp.json()["pending_token"]
        code = captured_otps[-1][1]

        verify_resp = client.post(
            "/auth/verify-login-otp",
            json={"pending_token": pending_token, "code": code, "remember_device": True},
        )
        device_token = verify_resp.json()["device_token"]
        assert device_token is not None

        # A second login presenting that device_token skips the OTP step --
        # no new OTP is captured, and a real token comes back immediately.
        otps_before = len(captured_otps)
        second_login = client.post(
            "/auth/login",
            json={"badge_number": BADGE, "password": PASSWORD, "device_token": device_token},
        )
        assert second_login.status_code == 200
        body = second_login.json()
        assert body["token"] is not None
        assert body["otp_required"] is False
        assert len(captured_otps) == otps_before
    finally:
        _set_officer_email(BADGE, None)


def test_an_unrecognized_device_token_does_not_skip_otp(client, captured_otps):
    _set_officer_email(BADGE, "officer@example.com")
    try:
        resp = client.post(
            "/auth/login",
            json={"badge_number": BADGE, "password": PASSWORD, "device_token": "some-other-devices-token"},
        )
        assert resp.json()["otp_required"] is True
    finally:
        _set_officer_email(BADGE, None)


def test_request_password_reset_otp_for_unknown_badge_returns_the_same_generic_message(client, captured_otps):
    resp = client.post("/auth/request-password-reset-otp", json={"badge_number": "GJ-NOPE-999"})
    assert resp.status_code == 200
    assert "If that account exists" in resp.json()["message"]
    assert captured_otps == []


def test_request_password_reset_otp_for_an_officer_with_no_email_sends_nothing(client, captured_otps):
    resp = client.post("/auth/request-password-reset-otp", json={"badge_number": BADGE})
    assert resp.status_code == 200
    assert captured_otps == []


def test_full_self_service_password_reset_flow(client, captured_otps):
    _set_officer_email(BADGE, "officer@example.com")
    try:
        client.post("/auth/request-password-reset-otp", json={"badge_number": BADGE})
        code = captured_otps[-1][1]

        resp = client.post(
            "/auth/reset-password-with-otp",
            json={"badge_number": BADGE, "code": code, "new_password": "a-brand-new-password"},
        )
        assert resp.status_code == 200

        old_login = client.post("/auth/login", json={"badge_number": BADGE, "password": PASSWORD})
        assert old_login.status_code == 401

        new_login = client.post(
            "/auth/login", json={"badge_number": BADGE, "password": "a-brand-new-password"}
        )
        assert new_login.status_code == 200
    finally:
        with get_conn() as conn:
            officer = auth_service.get_officer_by_badge(conn, BADGE)
            auth_service.set_password(conn, officer["id"], auth_service.hash_password(PASSWORD))
            auth_service.set_email(conn, officer["id"], None)


def test_reset_password_with_wrong_code_is_rejected(client, captured_otps):
    _set_officer_email(BADGE, "officer@example.com")
    try:
        client.post("/auth/request-password-reset-otp", json={"badge_number": BADGE})
        resp = client.post(
            "/auth/reset-password-with-otp",
            json={"badge_number": BADGE, "code": "000000", "new_password": "whatever123"},
        )
        assert resp.status_code == 401
    finally:
        _set_officer_email(BADGE, None)


def test_otp_verify_attempts_are_capped(client, captured_otps):
    _set_officer_email(BADGE, "officer@example.com")
    try:
        client.post("/auth/request-password-reset-otp", json={"badge_number": BADGE})
        code = captured_otps[-1][1]

        for _ in range(5):
            wrong = client.post(
                "/auth/reset-password-with-otp",
                json={"badge_number": BADGE, "code": "000000", "new_password": "whatever123"},
            )
            assert wrong.status_code == 401

        # The 6th attempt, even with the CORRECT code, is rejected -- the
        # attempt cap has already been hit.
        resp = client.post(
            "/auth/reset-password-with-otp",
            json={"badge_number": BADGE, "code": code, "new_password": "whatever123"},
        )
        assert resp.status_code == 401
    finally:
        _set_officer_email(BADGE, None)


def test_update_my_email_requires_correct_current_password(client, captured_otps):
    login = client.post("/auth/login", json={"badge_number": BADGE, "password": PASSWORD})
    token = login.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    wrong = client.put(
        "/auth/me/email", json={"email": "new@example.com", "current_password": "wrong"}, headers=headers
    )
    assert wrong.status_code == 401


def test_setting_a_new_email_requires_otp_verification_before_it_takes_effect(client, captured_otps):
    login = client.post("/auth/login", json={"badge_number": BADGE, "password": PASSWORD})
    token = login.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    try:
        resp = client.put(
            "/auth/me/email", json={"email": "new@example.com", "current_password": PASSWORD}, headers=headers
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["verification_required"] is True
        assert "pending_token" in body
        assert captured_otps == [("new@example.com", captured_otps[0][1], "email_verification")]

        # Not written to officers.email yet.
        me = client.get("/auth/me", headers=headers).json()
        assert me["email"] is None

        verify = client.post(
            "/auth/me/email/verify",
            json={"pending_token": body["pending_token"], "code": captured_otps[0][1]},
            headers=headers,
        )
        assert verify.status_code == 200
        assert verify.json()["email"] == "new@example.com"
    finally:
        _set_officer_email(BADGE, None)


def test_email_verification_with_the_wrong_code_does_not_set_it(client, captured_otps):
    login = client.post("/auth/login", json={"badge_number": BADGE, "password": PASSWORD})
    token = login.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    resp = client.put(
        "/auth/me/email", json={"email": "new@example.com", "current_password": PASSWORD}, headers=headers
    )
    pending_token = resp.json()["pending_token"]

    verify = client.post(
        "/auth/me/email/verify", json={"pending_token": pending_token, "code": "000000"}, headers=headers
    )
    assert verify.status_code == 401
    assert client.get("/auth/me", headers=headers).json()["email"] is None


def test_email_verification_token_cannot_be_used_by_a_different_officer(client, captured_otps):
    sa_login = client.post("/auth/login", json={"badge_number": BADGE, "password": PASSWORD})
    sa_headers = {"Authorization": f"Bearer {sa_login.json()['token']}"}
    resp = client.put(
        "/auth/me/email", json={"email": "new@example.com", "current_password": PASSWORD}, headers=sa_headers
    )
    pending_token = resp.json()["pending_token"]
    code = captured_otps[0][1]

    other_login = client.post(
        "/auth/login", json={"badge_number": "GJ-DC-001", "password": "demo-pass-district-command"}
    )
    other_headers = {"Authorization": f"Bearer {other_login.json()['token']}"}

    stolen = client.post(
        "/auth/me/email/verify", json={"pending_token": pending_token, "code": code}, headers=other_headers
    )
    assert stolen.status_code == 403


def test_clearing_email_is_rejected_now_that_2fa_is_mandatory(client, captured_otps):
    _set_officer_email(BADGE, "officer@example.com")
    login = client.post("/auth/login", json={"badge_number": BADGE, "password": PASSWORD})
    pending_token = login.json()["pending_token"]
    verify = client.post(
        "/auth/verify-login-otp", json={"pending_token": pending_token, "code": captured_otps[-1][1]}
    )
    headers = {"Authorization": f"Bearer {verify.json()['token']}"}

    resp = client.put("/auth/me/email", json={"email": None, "current_password": PASSWORD}, headers=headers)
    assert resp.status_code == 422
