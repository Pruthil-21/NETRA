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


settings = Settings()