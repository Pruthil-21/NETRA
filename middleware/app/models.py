import ipaddress
from datetime import datetime, timezone
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator, model_validator


def utcnow():
    return datetime.now(timezone.utc).isoformat()


# Hostnames/suffixes that never denote a real external camera-inventory
# origin -- blocking these at config time keeps whoever holds
# FEDERATION_SERVICE_KEY (a single secret shared with backend-registry's
# proxy) from pointing a source at internal-only infrastructure (this
# deployment's own services, cloud metadata, etc.) rather than being limited
# to the legitimate external origins this feature is actually for.
_BLOCKED_HOSTNAMES = {"localhost"}
_BLOCKED_HOST_SUFFIXES = (".internal", ".local", ".localhost")


def _is_blocked_host(hostname: str) -> bool:
    hostname = hostname.lower()
    if hostname in _BLOCKED_HOSTNAMES or hostname.endswith(_BLOCKED_HOST_SUFFIXES):
        return True
    try:
        ip = ipaddress.ip_address(hostname)
    except ValueError:
        return False  # a real DNS name, not an IP literal
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified


class Source(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")
    name: str = Field(min_length=1, max_length=120)
    adapter: Literal["organizer", "mediamtx"]
    inventory_url: str
    playback_base: str
    # Only deployment configuration can select remote destinations or credentials.
    headers_env: str | None = None
    ingest_key_env: str
    path_prefix: str = ""
    playback_template: str = "{id}/index.m3u8"
    representative: bool = False
    playback_available: bool = True
    force_ipv4: bool = False
    login_url: str | None = None
    login_email_env: str | None = None
    login_password_env: str | None = None

    @model_validator(mode="after")
    def login_configuration(self):
        if self.login_url:
            login, inventory = urlsplit(self.login_url), urlsplit(self.inventory_url)
            if login.scheme != "https" or (login.scheme, login.netloc) != (inventory.scheme, inventory.netloc) or login.query or login.fragment:
                raise ValueError("Login must use HTTPS on the inventory origin")
            if not self.login_email_env or not self.login_password_env or self.adapter != "organizer":
                raise ValueError("Organizer login requires both credential environment names")
        return self

    @field_validator("inventory_url", "playback_base")
    @classmethod
    def valid_url(cls, value):
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or parsed.query:
            raise ValueError("Use an HTTP(S) URL without credentials, query, or fragment")
        if _is_blocked_host(parsed.hostname):
            raise ValueError("URL host must be a real external origin, not a private/loopback/link-local/internal address")
        return value.rstrip("/")


class Camera(BaseModel):
    id: str
    source_id: str
    external_id: str
    name: str
    location: str | None = None
    latitude: float | None = Field(None, ge=-90, le=90)
    longitude: float | None = Field(None, ge=-180, le=180)
    playback_url: str | None
    status: Literal["ready", "not_ready", "unknown"] = "unknown"
    status_basis: str
    representative: bool = False


class Detection(BaseModel):
    event_id: str = Field(min_length=1, max_length=128)
    camera_id: str = Field(min_length=1, max_length=256)
    plate: str = Field(min_length=1, max_length=32)
    detected_at: datetime
    confidence: float = Field(ge=0, le=1)

    @field_validator("plate")
    @classmethod
    def normalize(cls, value):
        value = "".join(value.upper().split())
        if not value.isascii() or not value.isalnum():
            raise ValueError("Plate must contain ASCII letters and digits")
        return value

    @field_validator("detected_at")
    @classmethod
    def aware(cls, value):
        if value.tzinfo is None:
            raise ValueError("Timestamp must include timezone")
        return value.astimezone(timezone.utc)
