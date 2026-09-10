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


settings = Settings()