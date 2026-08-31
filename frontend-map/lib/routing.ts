import { GeoPosition } from '@/lib/geolocation';
import { haversineKm } from '@/lib/distance';

export interface DrivingRoute {
  /** [lat, long] pairs following actual roads, ready for a Leaflet Polyline. */
  coordinates: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  /** false when this came from the haversine fallback (routing service
   * unreachable/no road route found), not a real road-following path. */
  isRoadRoute: boolean;
}

// Public OSRM demo server -- free, no API key, fine for a demo's traffic
// volume. Not for production: unauthenticated, rate-limited, no uptime SLA.
const OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/driving';

// Used only for the fallback estimate below, never to draw a road path --
// average of city arterial + highway driving, reasonable for Gujarat
// distances without pretending to know the actual route taken.
const FALLBACK_AVG_SPEED_KMH = 40;

function haversineFallback(from: GeoPosition, to: GeoPosition): DrivingRoute {
  const km = haversineKm(from, to);
  return {
    coordinates: [
      [from.lat, from.long],
      [to.lat, to.long],
    ],
    distanceMeters: km * 1000,
    durationSeconds: (km / FALLBACK_AVG_SPEED_KMH) * 3600,
    isRoadRoute: false,
  };
}

/** Real turn-by-turn driving route between two points. Falls back to a
 * straight-line + estimated-speed guess if OSRM is unreachable or can't
 * find a road route -- always returns *something* usable rather than
 * leaving the map with no line at all. */
export async function fetchDrivingRoute(from: GeoPosition, to: GeoPosition): Promise<DrivingRoute> {
  const url = `${OSRM_BASE_URL}/${from.long},${from.lat};${to.long},${to.lat}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return haversineFallback(from, to);
    const data = await res.json();
    const route = data.routes?.[0];
    if (!route) return haversineFallback(from, to);
    return {
      coordinates: route.geometry.coordinates.map(([lng, lat]: [number, number]) => [lat, lng] as [number, number]),
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      isRoadRoute: true,
    };
  } catch {
    return haversineFallback(from, to);
  }
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 1) return '<1 min';
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export function formatEta(seconds: number): string {
  const eta = new Date(Date.now() + seconds * 1000);
  return eta.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
