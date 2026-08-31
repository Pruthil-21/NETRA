import { Camera } from '@/types/camera';
import { GeoPosition } from '@/lib/geolocation';

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: GeoPosition, b: GeoPosition): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLong = toRad(b.long - a.long);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLong / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Which camera is physically closest to a given position -- used to answer
 * "what city/area is the officer currently in" by proxy (this app has no
 * general reverse-geocoding, only camera locations), so the header alert
 * bell can scope itself to that camera's `dept`. */
export function findNearestCamera(pos: GeoPosition, cameras: Camera[]): Camera | null {
  let nearest: Camera | null = null;
  let nearestKm = Infinity;
  for (const cam of cameras) {
    if (cam.lat == null || cam.long == null) continue;
    const km = haversineKm(pos, { lat: cam.lat, long: cam.long });
    if (km < nearestKm) {
      nearestKm = km;
      nearest = cam;
    }
  }
  return nearest;
}
