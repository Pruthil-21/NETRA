// Mirrors backend-watchlist/app/services/geo.py exactly -- both need the
// same haversine/bearing math because bearing/speed only arrive from the
// backend on the scripted vehicle-trace-demo path (GET /vehicle-traces);
// a normal plate search (GET /detections, camera resolved client-side from
// the frontend's own registry) has real coordinates too but no server-side
// enrichment, so buildSightingRoute computes it here instead. Investigators
// searching a real plate get the same "inferred direction of travel" and
// average speed the demo path shows, not a lesser version of the feature.
const EARTH_RADIUS_KM = 6371.0088;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

export function initialBearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLambda = toRad(lon2 - lon1);
  const x = Math.sin(dLambda) * Math.cos(phi2);
  const y = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const theta = Math.atan2(x, y);
  return ((theta * 180) / Math.PI + 360) % 360;
}

/** bearing/speed for the leg from `prev` to `curr`. null/null when the two
 * timestamps don't actually advance (dividing by a non-positive duration
 * would produce a meaningless or negative speed). */
export function legBearingAndSpeed(
  prev: { lat: number; lon: number; detectedAt: string },
  curr: { lat: number; lon: number; detectedAt: string }
): { bearingDeg: number; speedKmh: number | null; gapHours: number } {
  const bearingDeg = initialBearingDeg(prev.lat, prev.lon, curr.lat, curr.lon);
  const dtHours =
    (new Date(curr.detectedAt).getTime() - new Date(prev.detectedAt).getTime()) / 1000 / 3600;
  if (dtHours <= 0) return { bearingDeg, speedKmh: null, gapHours: dtHours };

  const distanceKm = haversineKm(prev.lat, prev.lon, curr.lat, curr.lon);
  return { bearingDeg, speedKmh: Math.round((distanceKm / dtHours) * 10) / 10, gapHours: dtHours };
}

// Mirrors backend-watchlist/app/services/geo.py's classify_leg_anomaly and
// its two constants exactly -- see that module's docstring for why these
// are heuristics ("review this leg"), not findings.
export const MAX_PLAUSIBLE_SPEED_KMH = 160.0;
export const EXTENDED_GAP_HOURS = 12.0;
export const IMPROBABLE_SPEED = 'improbable_speed';
export const EXTENDED_GAP = 'extended_gap';

export function classifyLegAnomaly(speedKmh: number | null, gapHours: number | null): string | null {
  if (speedKmh != null && speedKmh > MAX_PLAUSIBLE_SPEED_KMH) return IMPROBABLE_SPEED;
  if (gapHours != null && gapHours > EXTENDED_GAP_HOURS) return EXTENDED_GAP;
  return null;
}
