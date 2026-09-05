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


settings = Settings()
