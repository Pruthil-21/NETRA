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

    # Manual Plate Lookup (see services/anpr_jobs_service.py) -- local-disk
    # storage for officer-uploaded clips/images, no object storage anywhere
    # in this stack yet. Caps are deliberately generous-but-bounded, not
    # unlimited: a phone video clip easily runs to tens of MB, a photo rarely
    # needs more than a few.
    anpr_upload_dir: str = os.environ.get("ANPR_UPLOAD_DIR", "uploads/anpr_jobs")
    anpr_max_video_bytes: int = int(os.environ.get("ANPR_MAX_VIDEO_BYTES", str(200 * 1024 * 1024)))
    anpr_max_image_bytes: int = int(os.environ.get("ANPR_MAX_IMAGE_BYTES", str(15 * 1024 * 1024)))
    # Where Avi's ml-anpr on-demand endpoint lives, and the base URL this
    # service's own callback (PATCH /anpr-jobs/{id}) is reachable at from
    # ml-anpr's side. Both unset just means dispatch fails fast with a clear
    # per-job error -- the job is still created and visible, matching the
    # "unreachable/unconfigured service is a normal state, never a 500"
    # convention recordings_service.py already follows.
    #
    # Avi runs ml-anpr from two places behind two separate tunnels -- his
    # GPU server (faster, but only up when he's got it running) and his
    # laptop (slower, but the one that's been reliably reachable). Dispatch
    # tries anpr_pipeline_url first and only falls through to
    # anpr_pipeline_fallback_url when the primary is actually unreachable
    # (connection refused/timed out), not merely erroring -- see
    # anpr_jobs_service._post_to_first_reachable_pipeline.
    anpr_pipeline_url: str = os.environ.get("ANPR_PIPELINE_URL", "")
    anpr_pipeline_fallback_url: str = os.environ.get("ANPR_PIPELINE_FALLBACK_URL", "")
    anpr_callback_base_url: str = os.environ.get("ANPR_CALLBACK_BASE_URL", "https://api.digdhrishti.me")
    # backend-registry's own base URL, called once per archive_clip job
    # (GET /internal/cameras/{id}/recording-clip-url) to mint a fresh clip
    # URL right before dispatch -- see anpr_jobs_service.dispatch_to_ml_anpr.
    # Local dev default matches this session's established bare-uvicorn port
    # (8010); docker-compose overrides this to the in-network service name.
    registry_internal_url: str = os.environ.get("REGISTRY_INTERNAL_URL", "http://localhost:8010")


settings = Settings()