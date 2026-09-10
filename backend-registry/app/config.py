"""Application configuration loaded from environment variables."""
import os

from dotenv import load_dotenv

load_dotenv()


class Settings:
    database_url: str = os.environ["DATABASE_URL"]
    jwt_secret: str = os.environ["JWT_SECRET"]
    # The standalone mock SNMP monitor (streaming/snmp/monitor.py) -- optional
    # demo infrastructure, not always running, so this has a default rather
    # than the hard-required DATABASE_URL/JWT_SECRET above.
    snmp_monitor_url: str = os.environ.get("SNMP_MONITOR_URL", "http://localhost:9116")
    # Base URL for a camera's HLS manifest, when it has no fully-qualified
    # hls_url of its own -- same real value as frontend-map's own
    # NEXT_PUBLIC_MEDIAMTX_HLS_URL (see GET /cameras/{id}/live-check).
    mediamtx_hls_url: str = os.environ.get("MEDIAMTX_HLS_URL", "http://localhost:8888")
    # Email 2FA / self-service password reset (see services/email_service.py)
    # is entirely opt-in per officer (gated on officers.email being set), so
    # this has a default rather than joining DATABASE_URL/JWT_SECRET as a
    # hard-required var -- a deployment that never configures Resend simply
    # never sends an officer-set email an OTP; login/reset behave exactly as
    # before for every officer with no email on file.
    resend_api_key: str = os.environ.get("RESEND_API_KEY", "")
    # Resend's own shared sandbox sender -- works out of the box with no
    # domain verification, but (per Resend's own restriction) can only
    # deliver to the email address that owns the RESEND_API_KEY's account
    # until a real sending domain is verified. Fine for dev/demo; swap for a
    # verified "you@yourdomain.com" address in production.
    resend_from_email: str = os.environ.get("RESEND_FROM_EMAIL", "DIGDHRISHTI <onboarding@resend.dev>")
    # Web Push (VAPID) -- see services/push_service.py. Optional: an unset
    # VAPID_PRIVATE_KEY just means push_service.send_to_badges skips sending
    # (logs and no-ops) rather than crashing, same "degrade, don't break"
    # posture as resend_api_key above.
    vapid_public_key: str = os.environ.get("VAPID_PUBLIC_KEY", "")
    vapid_private_key: str = os.environ.get("VAPID_PRIVATE_KEY", "")
    vapid_subject: str = os.environ.get("VAPID_SUBJECT", "mailto:admin@example.com")


settings = Settings()
