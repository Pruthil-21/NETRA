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

Async (httpx.AsyncClient), not the old blocking httpx.get -- this is now
called from cameras_service.run_periodic_connectivity_sweep under an
asyncio.Semaphore for hundreds of cameras concurrently; a blocking call here
would serialize the whole sweep and stall the event loop for every other
request on every cache miss.
"""
import time

import httpx

_TIMEOUT_SECONDS = 5.0

# GET /cameras/{id}/live-check (an officer's manual "Retry" affordance) and
# the periodic sweep can land on the same URL within moments of each other --
# a short TTL cache means they see the same answer instead of paying two
# independent round trips to MediaMTX for a result that couldn't plausibly
# have changed in between.
_CACHE_TTL_SECONDS = 8.0
_cache: dict[str, tuple[float, bool]] = {}


async def check_hls_reachable(client: httpx.AsyncClient, url: str) -> bool:
    now = time.monotonic()
    cached = _cache.get(url)
    if cached is not None and now - cached[0] < _CACHE_TTL_SECONDS:
        return cached[1]

    try:
        response = await client.get(url, timeout=_TIMEOUT_SECONDS, follow_redirects=True)
        reachable = response.status_code == 200
    except httpx.HTTPError:
        reachable = False

    _cache[url] = (now, reachable)
    return reachable
