import { Camera } from '@/types/camera';

/**
 * Real city per organizer camera id (1-30) -- geocoded from
 * lib/organizerCameraCoords.ts's own curated Nominatim lookups (one-time,
 * offline), not re-derived from the raw `location` label at runtime, which
 * is too free-text/inconsistent to parse reliably ("01 Chiman bhai Bridge",
 * "19 KHAPARIA GRAM PANCHAYAT , TALUKA GANDEVI, DISTRICT NAVSARI", etc).
 * 'Unknown' matches that file's own 'unknown' confidence entries -- camera
 * ids 20, 22, 23 had no reliably identifiable real-world location.
 */
const ORGANIZER_CAMERA_CITY: Record<number, string> = {
  1: 'Ahmedabad', 2: 'Ahmedabad', 3: 'Ahmedabad', 4: 'Ahmedabad', 5: 'Ahmedabad',
  6: 'Junagadh', 7: 'Gir Somnath', 8: 'Junagadh', 9: 'Junagadh', 10: 'Junagadh', 11: 'Junagadh',
  12: 'Ahmedabad', 13: 'Ahmedabad', 14: 'Ahmedabad', 15: 'Ahmedabad', 16: 'Ahmedabad',
  17: 'Rajkot', 18: 'Rajkot',
  19: 'Navsari', 20: 'Unknown', 21: 'Patan', 22: 'Unknown', 23: 'Unknown',
  24: 'Gandhinagar', 25: 'Navsari', 26: 'Navsari', 27: 'Navsari', 28: 'Navsari', 29: 'Navsari',
  30: 'Kutch',
};

/** City bucket for a camera -- used to group alerts by city, not by the raw
 * camera.dept field (which for organizer cameras holds a landmark/locality
 * label like "04 Paldi Circle", too granular for a city-level view). Our own
 * manual/demo/test cameras already store dept as "City, State" (e.g.
 * "Petlad, Gujarat"), so just the city part of that is used for those. */
export function getCameraCity(camera: Camera): string {
  const organizerCity = ORGANIZER_CAMERA_CITY[camera.id];
  if (organizerCity) return organizerCity;
  const [city] = (camera.dept || 'Unknown').split(',');
  return city.trim() || 'Unknown';
}
