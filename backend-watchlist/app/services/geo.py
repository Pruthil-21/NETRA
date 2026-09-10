"""Pure geometry helpers for the vehicle-trace trajectory view -- no DB
access, so these are trivial to unit-test in isolation from the rest of
detections_service.

Direction/speed here are inferred from the order and spacing of fixed ANPR
camera reads, the same way large-scale ALPR platforms (e.g. Genetec AutoVu's
ML Core) report "direction of travel" and average speed between fixed
checkpoints -- not continuous GPS, just consecutive known points and a time
delta. The frontend labels this "inferred", never "GPS tracking", to keep
that distinction honest to an investigator reading it.
"""
import math

EARTH_RADIUS_KM = 6371.0088

# Anomaly heuristics -- deliberately simple, deliberately named as heuristics
# rather than "detected fraud": a real investigator treats these as "review
# this leg", not proof of anything. Two signals a plain route-on-a-map never
# surfaces, both explicitly called out in the brief this feature is built
# against ("flagging... suspicious route anomalies"):
#   - IMPROBABLE_SPEED: the two reads imply a speed no real vehicle covers
#     that ground distance in that time on Indian roads -- almost always a
#     wrong-plate OCR match (two different vehicles' reads merged into one
#     plate's history) rather than an actual 160+ km/h drive between fixed
#     checkpoints.
#   - EXTENDED_GAP: the plate vanishes for a long stretch between two
#     otherwise-active checkpoints -- not proof of anything by itself (it
#     could've simply left the ANPR-covered road network), but exactly the
#     kind of gap worth a human glancing at when reviewing a plate's history.
MAX_PLAUSIBLE_SPEED_KMH = 160.0
EXTENDED_GAP_HOURS = 12.0

IMPROBABLE_SPEED = "improbable_speed"
EXTENDED_GAP = "extended_gap"


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two lat/long points, in kilometers."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def initial_bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Compass bearing (0-360, 0 = north) from point 1 to point 2."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    x = math.sin(dlambda) * math.cos(phi2)
    y = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlambda)
    theta = math.atan2(x, y)
    return (math.degrees(theta) + 360) % 360


def leg_bearing_and_speed(prev: dict, curr: dict) -> tuple[float | None, float | None]:
    """bearing_deg/speed_kmh for the leg from `prev` to `curr`, each a dict
    with latitude/longitude/detected_at. None/None when either point lacks
    coordinates, or the two timestamps don't actually advance (a replayed/
    out-of-order pair -- dividing by a non-positive duration would produce a
    meaningless or negative speed)."""
    if None in (prev.get("latitude"), prev.get("longitude"), curr.get("latitude"), curr.get("longitude")):
        return None, None

    bearing = initial_bearing_deg(prev["latitude"], prev["longitude"], curr["latitude"], curr["longitude"])
    dt_hours = (curr["detected_at"] - prev["detected_at"]).total_seconds() / 3600
    if dt_hours <= 0:
        return bearing, None

    distance_km = haversine_km(prev["latitude"], prev["longitude"], curr["latitude"], curr["longitude"])
    return bearing, round(distance_km / dt_hours, 1)


def classify_leg_anomaly(speed_kmh: float | None, gap_hours: float | None) -> str | None:
    """Which heuristic (if any) this leg trips, checked in this order:
    an improbable speed is the stronger, more specific signal (implies a
    likely OCR mismatch) and takes priority over a merely-long gap when a
    leg somehow trips both."""
    if speed_kmh is not None and speed_kmh > MAX_PLAUSIBLE_SPEED_KMH:
        return IMPROBABLE_SPEED
    if gap_hours is not None and gap_hours > EXTENDED_GAP_HOURS:
        return EXTENDED_GAP
    return None
