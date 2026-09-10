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
import httpx

_TIMEOUT_SECONDS = 5.0


def check_hls_reachable(url: str) -> bool:
    try:
        response = httpx.get(url, timeout=_TIMEOUT_SECONDS, follow_redirects=True)
    except httpx.HTTPError:
        return False
    return response.status_code == 200
