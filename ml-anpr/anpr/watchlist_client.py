"""Sends confirmed plate reads to backend-watchlist."""
import requests

from .config import CAMERA_ID_MAP, INTERNAL_KEY, DETECTION_API_URL


def send_detection_to_watchlist(plate_number, camera_id_str, confidence=None):
    """POSTs one confirmed plate read to backend-watchlist's POST /detections
    -- the single ingestion endpoint for every confirmed read, not just
    watchlist matches (contract change, see config.DETECTION_API_URL
    comment). Unlike the retired POST /alerts, this always returns 201
    with {detection, alert}; alert is null when the plate isn't on the
    watchlist, which is the normal/expected case for most detections.
    """
    camera_id_int = CAMERA_ID_MAP.get(camera_id_str)
    if camera_id_int is None:
        print(f"[WARN] No numeric camera_id mapped for '{camera_id_str}', skipping API call")
        return

    headers = {"X-Internal-Key": INTERNAL_KEY}
    body = {
        "camera_id": camera_id_int,
        "plate_number": plate_number,
        "confidence": confidence,
    }
    try:
        response = requests.post(DETECTION_API_URL, json=body, headers=headers, timeout=3)
        if response.status_code == 201:
            result = response.json()
            if result.get("alert") is not None:
                print(f"[ALERT] Watchlist match: {result['alert']}")
        else:
            print(f"[WARN] Unexpected response {response.status_code}: {response.text}")
    except requests.exceptions.RequestException as e:
        print(f"[WARN] Could not reach watchlist API: {e}")
