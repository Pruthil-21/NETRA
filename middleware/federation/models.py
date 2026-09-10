from pydantic import Field
from typing import Literal
from app.models import Source as LegacySource


class Source(LegacySource):
    adapter: Literal['organizer', 'mediamtx', 'delta']
    ingest_key_env: str = ''  # Accepted for old configuration compatibility; never used.
    sync_interval_seconds: int = Field(300, ge=10)
    full_reconcile_seconds: int = Field(3600, ge=60)
    page_size: int = Field(1000, ge=1, le=5000)
    max_response_bytes: int = Field(128_000_000, ge=1024)
    max_pages: int = Field(10000, ge=1)
