"""Talks to the DIGDHRISHTI continuous-recording service (streaming/recording
-- Dhruv's project, deployed independently, kept fully separate; this is the
only file that talks to it) to list a camera's recorded segments and check
its recording health. Replaces the old direct-to-MediaMTX Playback API
integration: that only ever recorded while someone was watching a live feed,
so there was rarely anything evidentiary to browse. The recording service's
own admin key (RECORDING_SERVICE_KEY) never leaves this file -- cameras.py's
endpoints proxy through it instead of the browser talking to the recording
service directly.

Same defensive shape as the old code and federation_proxy.py: an
unreachable/unconfigured service is a normal, expected state (a deployment
that hasn't set RECORDING_SERVICE_URL/RECORDING_SERVICE_KEY yet, or the
service being mid-rollout -- see .env.example), never a 500.
"""
import os
from datetime import datetime, timedelta, timezone

import httpx

_TIMEOUT_SECONDS = 5.0
# How far back to look when a caller doesn't specify a range -- matches the
# 30-day evidentiary retention assumed in SCALABILITY.md's storage math, not
# the recording service's own configured retention (unconfirmed until it's
# actually deployed). Just this proxy's own default query window for "give
# me this camera's whole history" callers (the Archive calendar).
DEFAULT_LOOKBACK = timedelta(days=30)


def _base_url() -> str:
    return os.environ.get("RECORDING_SERVICE_URL", "")


def _service_key() -> str:
    return os.environ.get("RECORDING_SERVICE_KEY", "")


def _recording_path(stream_id: str) -> str:
    # The registry stores stream_id bare (e.g. "demo-cam67", "8") -- every
    # other caller (frontend-map's lib/stream.ts getHlsStreamUrl, MediaMTX's
    # own /stream/<id>/... convention) prepends "stream/" itself rather than
    # baking it into the stored value, and the recording service's `path`
    # query param follows the same convention (confirmed against Dhruv's
    # verified paths, e.g. "stream/demo-cam67" -- the bare id alone 404s).
    return f"stream/{stream_id}"


def _headers(service_key: str, actor_id: str) -> dict:
    # Cloudflare (fronting the recording service's tunnel) rejects generic
    # Python-library user agents -- confirmed by Dhruv against urllib's
    # default, and httpx's own default ("python-httpx/x.x.x") is the same
    # shape of string, so it's set explicitly here rather than left to
    # httpx's default.
    return {
        "X-Service-Key": service_key,
        "X-Actor-ID": actor_id,
        "User-Agent": "DIGDHRISHTI-Registry/1.0",
    }


def list_recordings(stream_id: str, actor_id: str, start: str | None = None, end: str | None = None) -> dict:
    base_url = _base_url()
    service_key = _service_key()
    if not base_url or not service_key:
        return {"available": False, "segments": []}

    now = datetime.now(timezone.utc)
    params = {
        "path": _recording_path(str(stream_id)),
        "start": start or (now - DEFAULT_LOOKBACK).isoformat(),
        "end": end or now.isoformat(),
    }
    try:
        response = httpx.get(
            f"{base_url}/list",
            params=params,
            headers=_headers(service_key, actor_id),
            timeout=_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
    except httpx.HTTPError:
        return {"available": False, "segments": []}

    # The recording service returns [{"start", "duration", "url"}, ...] --
    # `url` is a camera/range-scoped playback link (15-minute token baked
    # in), meant to be handed to a <video> element or download link as-is.
    # Never build our own /get URL from these fields -- only the recording
    # service can mint a valid token for a given range.
    segments = response.json()
    return {"available": len(segments) > 0, "segments": segments}


def recording_health(stream_id: str, actor_id: str) -> dict | None:
    base_url = _base_url()
    service_key = _service_key()
    if not base_url or not service_key:
        return None
    try:
        response = httpx.get(
            f"{base_url}/api/health",
            params={"path": _recording_path(str(stream_id))},
            headers=_headers(service_key, actor_id),
            timeout=_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
    except httpx.HTTPError:
        return None
    return response.json()
