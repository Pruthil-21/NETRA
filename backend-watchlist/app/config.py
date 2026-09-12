"""Application configuration loaded from environment variables."""
import os

from dotenv import load_dotenv

load_dotenv()


class Settings:
    database_url: str = os.environ["DATABASE_URL"]
    jwt_secret: str = os.environ["JWT_SECRET"]
    # Detections arrive from ml-anpr, a service, not a logged-in user —
    # gated by a shared key instead of a user JWT.
    internal_service_key: str = os.environ.get("INTERNAL_SERVICE_KEY", "dev-internal-key")

    # Congestion-alert evaluation (traffic_alerts_service) -- env-configurable
    # defaults rather than an admin-editable UI; deliberately kept simple for
    # this pass. A camera whose live-window count crosses
    # TRAFFIC_DENSITY_ALERT_THRESHOLD, or a corridor whose live-window
    # average speed drops below TRAFFIC_FLOW_CONGESTION_SPEED_KMH, triggers
    # a traffic_alerts row (subject to the cooldown below).
    traffic_alert_eval_interval_seconds: int = int(os.environ.get("TRAFFIC_ALERT_EVAL_INTERVAL_SECONDS", 300))
    traffic_alert_window_minutes: int = int(os.environ.get("TRAFFIC_ALERT_WINDOW_MINUTES", 15))
    traffic_density_alert_threshold: int = int(os.environ.get("TRAFFIC_DENSITY_ALERT_THRESHOLD", 50))
    traffic_flow_congestion_speed_kmh: float = float(os.environ.get("TRAFFIC_FLOW_CONGESTION_SPEED_KMH", 10.0))
    # Skip re-firing a new alert for a camera/corridor that already has an
    # unresolved (NEW/ACKNOWLEDGED) one within this many minutes -- otherwise
    # every 5-minute tick during a sustained jam would create a fresh row.
    traffic_alert_cooldown_minutes: int = int(os.environ.get("TRAFFIC_ALERT_COOLDOWN_MINUTES", 30))

    # A camera going offline briefly (a tunnel blip, a reboot) is normal and
    # not worth an alert -- only a camera that's STAYED offline this long,
    # continuously, without a single online transition in between, fires one.
    # Reuses the same evaluation tick/cooldown machinery as density/flow
    # above (traffic_alerts_service.evaluate_and_broadcast), just a third
    # alert_type on the same table.
    camera_offline_alert_threshold_minutes: int = int(os.environ.get("CAMERA_OFFLINE_ALERT_THRESHOLD_MINUTES", 30))

    # Web Push (VAPID) -- see services/push_service.py. Optional: an unset
    # VAPID_PRIVATE_KEY just means push_service.send_to_badges skips sending
    # (no-ops) rather than crashing -- every other alert path (WS, poll) is
    # completely unaffected.
    vapid_public_key: str = os.environ.get("VAPID_PUBLIC_KEY", "")
    vapid_private_key: str = os.environ.get("VAPID_PRIVATE_KEY", "")
    vapid_subject: str = os.environ.get("VAPID_SUBJECT", "mailto:admin@example.com")


settings = Settings()