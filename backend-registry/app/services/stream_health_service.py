"""Real, server-side reachability check for a camera's HLS manifest --
replaces the frontend's old client-side check, which had to use
`fetch(url, {mode: 'no-cors'})` because cross-origin tunnel responses don't
send Access-Control-Allow-Origin. In no-cors mode the browser can't read
the actual HTTP status, so ANY response at all (a 404 from a path with no
active publisher included) resolved the fetch successfully -- the false
"LIVE" badge this service exists to fix. A server-to-server request has no
CORS restriction at all, so this reads the real status code: MediaMTX only
serves the .m3u8 manifest (200) for a path someone is actively publishing
to, and 404s an unpublished one -- an actually correct signal, not a
"is the host merely up" guess.
"""
import time

import httpx

_TIMEOUT_SECONDS = 5.0

# Two independent frontend pollers (CameraRegistryContext's map-wide check
# and useCameraFeeds' dashboard check) hit this per camera on their own
# ~15-20s intervals, from however many tabs an officer has open -- without
# this, each one pays a fresh network round trip to MediaMTX for the exact
# same URL within the same few seconds, and can disagree with each other
# purely from timing (one call lands mid-blip, the other doesn't). A short
# TTL cache means near-simultaneous callers see the same answer and the
# relay isn't hit more often than the result could plausibly have changed.
_CACHE_TTL_SECONDS = 8.0
_cache: dict[str, tuple[float, bool]] = {}


def check_hls_reachable(url: str) -> bool:
    now = time.monotonic()
    cached = _cache.get(url)
    if cached is not None and now - cached[0] < _CACHE_TTL_SECONDS:
        return cached[1]

    try:
        response = httpx.get(url, timeout=_TIMEOUT_SECONDS, follow_redirects=True)
        reachable = response.status_code == 200
    except httpx.HTTPError:
        reachable = False

    _cache[url] = (now, reachable)
    return reachable
