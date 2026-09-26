"""Sends confirmed plate reads to backend-watchlist."""
import uuid

import requests

from .config import CAMERA_ID_MAP, INTERNAL_KEY, DETECTION_API_URL

# 10s per the real handoff's own guidance ("10 seconds is generous for
# this endpoint") -- was 3s, tighter than what P6 documented as normal,
# which risked this one-shot (no-retry) caller giving up on a request
# that just needed a bit more time over a real network hop to a
# production domain, not the old same-network tunnel.
REQUEST_TIMEOUT_SEC = 10


def send_detection_to_watchlist(plate_number, camera_id_str, confidence=None):
    """POSTs one confirmed plate read to backend-watchlist's POST /detections
    -- the single ingestion endpoint for every confirmed read, not just
    watchlist matches (contract change, see config.DETECTION_API_URL
    comment). Unlike the retired POST /alerts, this always returns 201
    with {detection, alert}; alert is null when the plate isn't on the
    watchlist, which is the normal/expected case for most detections.

    Sends a fresh event_id even though this function never retries --
    "strongly recommended" per the handoff, and a caller elsewhere might
    reasonably re-invoke this same function for the same real sighting
    after a failure (e.g. a higher-level retry loop this function itself
    doesn't have); giving that retry real idempotency costs one line here.
    """
    camera_id_int = CAMERA_ID_MAP.get(camera_id_str)
    if camera_id_int is None:
        print(f"[WARN] No numeric camera_id mapped for '{camera_id_str}', skipping API call")
        return

    # Cloudflare's bot-fight-mode in front of the real tunnel rejects
    # requests' own default UA ("python-requests/x.x", a known automation
    # signature) with a 403 before it ever reaches backend-watchlist --
    # confirmed directly by P6/Pruthil hitting the same wall. A normal
    # browser-shaped UA clears it.
    headers = {
        "X-Internal-Key": INTERNAL_KEY,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    }
    body = {
        "camera_id": camera_id_int,
        "plate_number": plate_number,
        "confidence": confidence,
        "event_id": str(uuid.uuid4()),
    }
    try:
        response = requests.post(DETECTION_API_URL, json=body, headers=headers,
                                  timeout=REQUEST_TIMEOUT_SEC)
        if response.status_code == 201:
            result = response.json()
            if result.get("alert") is not None:
                print(f"[ALERT] Watchlist match: {result['alert']}")
        elif response.status_code == 401:
            print("[WARN] backend-watchlist rejected X-Internal-Key (401) -- "
                  "check config.INTERNAL_KEY, retrying won't help")
        else:
            print(f"[WARN] Unexpected response {response.status_code}: {response.text}")
    except requests.exceptions.RequestException as e:
        print(f"[WARN] Could not reach watchlist API: {e}")
