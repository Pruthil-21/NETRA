"""Talks to MediaMTX's Playback API (streaming/mediamtx.yml's `playback`
server -- see streaming/README.md's "Recorded footage / VOD playback"
section) to list a camera's recorded segments. Clip streaming/export itself
is served directly from MediaMTX to the browser, not proxied here -- this
only answers "what time ranges exist to scrub through."

Same defensive shape as snmp_service: the playback server (or a camera with
no recordings yet) is a normal, expected state, never a 500.
"""
import httpx

from ..config import settings

_TIMEOUT_SECONDS = 5.0


def list_recordings(stream_id: str) -> dict:
    try:
        response = httpx.get(
            f"{settings.playback_api_url}/list",
            params={"path": str(stream_id)},
            timeout=_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
    except httpx.HTTPError:
        return {"available": False, "segments": []}

    # MediaMTX returns [{"start": "<RFC3339>", "duration": <seconds>}, ...]
    # for a path with recordings, and a 404 (raised above as HTTPError) for
    # one with none -- so reaching here always means at least one segment.
    return {"available": True, "segments": response.json()}
