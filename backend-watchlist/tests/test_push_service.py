import contextlib
import uuid

import psycopg2
import psycopg2.extras
import pytest
from app.config import settings
from app.services import push_service


def _direct_conn():
    conn = psycopg2.connect(settings.database_url)
    conn.autocommit = True
    return conn


def _insert_officer_with_posting(scope_type: str, scope_value: str | None) -> tuple[int, str]:
    badge = f"GJ-PUSH-{uuid.uuid4().hex[:6].upper()}"
    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "INSERT INTO officers (badge_number, name, password_hash) VALUES (%s, %s, 'x') RETURNING id",
            (badge, badge),
        )
        officer_id = cur.fetchone()["id"]
        cur.execute("SELECT id FROM roles LIMIT 1")
        role_id = cur.fetchone()["id"]
        cur.execute(
            "INSERT INTO postings (officer_id, role_id, scope_type, scope_value, is_active) "
            "VALUES (%s, %s, %s, %s, true)",
            (officer_id, role_id, scope_type, scope_value),
        )
    return officer_id, badge


def _cleanup_officer(officer_id: int):
    with _direct_conn() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM postings WHERE officer_id = %s", (officer_id,))
        cur.execute("DELETE FROM officers WHERE id = %s", (officer_id,))


@pytest.fixture
def push_test_officers():
    created: list[int] = []
    yield created
    for officer_id in created:
        _cleanup_officer(officer_id)


def test_recipients_for_scope_includes_platform_and_matching_district(push_test_officers):
    platform_id, platform_badge = _insert_officer_with_posting("platform", None)
    push_test_officers.append(platform_id)
    district_id, district_badge = _insert_officer_with_posting("district", "Push Test District A")
    push_test_officers.append(district_id)
    other_id, other_badge = _insert_officer_with_posting("district", "Push Test District B")
    push_test_officers.append(other_id)

    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        recipients = push_service.recipients_for_scope(cur, "Push Test District A")

    assert platform_badge in recipients
    assert district_badge in recipients
    assert other_badge not in recipients


def test_send_to_badges_noops_when_vapid_not_configured(monkeypatch, push_test_officers):
    monkeypatch.setattr(settings, "vapid_private_key", "")
    officer_id, badge = _insert_officer_with_posting("platform", None)
    push_test_officers.append(officer_id)

    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        # Would raise if it actually tried to query push_subscriptions/send --
        # proves the early-return happens before any of that.
        push_service.send_to_badges(cur, [badge], {"title": "x", "body": "y", "url": "/"})


def test_send_to_badges_calls_webpush_and_evicts_expired_subscriptions(monkeypatch, push_test_officers):
    from pywebpush import WebPushException

    monkeypatch.setattr(settings, "vapid_private_key", "test-private-key")
    monkeypatch.setattr(settings, "vapid_subject", "mailto:test@example.com")

    officer_id, badge = _insert_officer_with_posting("platform", None)
    push_test_officers.append(officer_id)

    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "INSERT INTO push_subscriptions (badge_number, endpoint, p256dh_key, auth_key) "
            "VALUES (%s, %s, 'p256dh', 'auth') RETURNING id",
            (badge, f"https://push.example.com/{uuid.uuid4().hex}"),
        )
        sub_id = cur.fetchone()["id"]

        calls = []

        class _FakeResponse:
            status_code = 410

        def _fake_webpush(**kwargs):
            calls.append(kwargs)
            raise WebPushException("gone", response=_FakeResponse())

        monkeypatch.setattr(push_service, "webpush", _fake_webpush)

        push_service.send_to_badges(cur, [badge], {"title": "x", "body": "y", "url": "/"})
        assert len(calls) == 1
        assert calls[0]["vapid_claims"] == {"sub": "mailto:test@example.com"}

        cur.execute("SELECT id FROM push_subscriptions WHERE id = %s", (sub_id,))
        assert cur.fetchone() is None, "a 410 response must evict the dead subscription"
