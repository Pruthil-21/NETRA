"""Thin wrapper around Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email)
-- no SDK dependency, just one POST, matching this codebase's existing
pattern of talking to small external HTTP services directly (see
backend-watchlist's snmp_service).

Deliberately synchronous/blocking: every caller today is inside a request
handler that's about to tell the user "check your email" regardless of
whether the send actually lands in the next 200ms or the next 2s, so there's
no responsiveness win from making this async, only complexity.
"""
import httpx

from ..config import settings

RESEND_API_URL = "https://api.resend.com/emails"


class EmailSendError(Exception):
    """Raised when Resend rejects or fails to accept the send -- callers
    decide whether that should surface to the user (e.g. "couldn't send
    reset email, try again") or just be logged, never silently swallowed
    here, since a caller in the middle of a 2FA/password-reset flow needs to
    know the code never actually reached the officer."""


def send_email(to: str, subject: str, html: str) -> None:
    if not settings.resend_api_key:
        raise EmailSendError("RESEND_API_KEY is not configured")

    response = httpx.post(
        RESEND_API_URL,
        headers={"Authorization": f"Bearer {settings.resend_api_key}"},
        json={"from": settings.resend_from_email, "to": [to], "subject": subject, "html": html},
        timeout=10,
    )
    if response.status_code >= 400:
        raise EmailSendError(f"Resend rejected the email: HTTP {response.status_code} {response.text}")


def send_otp_email(to: str, code: str, purpose: str) -> None:
    if purpose == "login_2fa":
        subject = "Your DIGDHRISHTI login code"
        intro = "Use this code to finish signing in to DIGDHRISHTI"
    else:
        subject = "Reset your DIGDHRISHTI password"
        intro = "Use this code to reset your DIGDHRISHTI password"

    html = f"""
        <p>{intro}:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px;">{code}</p>
        <p>This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
    """
    send_email(to, subject, html)
