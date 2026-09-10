import { Camera } from '@/types/camera';
import { GUJARAT_BOUNDARY_RINGS } from './gujaratBoundary';

/** What one registered camera contributes to the coverage map: 'operational'
 * (online + healthy) paints green, 'degraded' paints amber -- everything
 * else, including fully offline, since a camera that's down still marks a
 * spot as "watched, but not reliably" rather than "never watched at all."
 * Red (see COVERAGE_COLORS.blind, the base fill) is reserved for genuine
 * gaps -- no registered camera within reach at all. */
export type CoverageStatus = 'operational' | 'degraded';

export function coverageStatusForCamera(cam: Camera): CoverageStatus {
  const online = cam.connectivity_status?.toLowerCase() === 'online';
  const healthy = cam.health_status?.toLowerCase() === 'operational';
  return online && healthy ? 'operational' : 'degraded';
}

/** Three simultaneous, always-visible states -- not an exclusive toggle
 * like a 4G/5G pill group. Every point in Gujarat is exactly one of these
 * at a time: reliably watched (green), watched but shaky (amber), or a
 * blind spot (red, the base fill applied to the whole state before any
 * camera circle is drawn over it). */
export const COVERAGE_COLORS: Record<'operational' | 'degraded' | 'blind', string> = {
  operational: '#22c55e',
  degraded: '#f59e0b',
  blind: '#ef4444',
};

export const COVERAGE_LEGEND: { status: 'operational' | 'degraded' | 'blind'; label: string }[] = [
  { status: 'operational', label: 'Operational coverage' },
  { status: 'degraded', label: 'Registered, not operational' },
  { status: 'blind', label: 'No coverage' },
];

// A flat assumed radius, the same for every camera regardless of type --
// the registry has no measured optical range per camera, so this is a
// clearly-approximate stand-in, not a survey. Chosen (not derived) so it
// stays a single tunable constant.
export const COVERAGE_RADIUS_METERS = 80;

// A cheap bounding-box pre-check before the real point-in-polygon test
// below -- rejects the vast majority of out-of-state points (and every
// camera outside India entirely) without walking any ring at all. Derived
// from GUJARAT_BOUNDARY_RINGS's own extent, not a hand-picked guess.
export const GUJARAT_BOUNDS = {
  south: 20.1,
  north: 24.8,
  west: 68.1,
  east: 74.5,
};

// Standard even-odd ray-casting point-in-polygon test. `ring` is a closed
// [lat, long] ring (GUJARAT_BOUNDARY_RINGS' shape); works for any simple
// polygon, convex or not, which Gujarat's real coastline very much is.
function pointInRing(lat: number, long: number, ring: readonly [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    const crosses = yi > lat !== yj > lat && long < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** True accurate-shape test against Gujarat's real boundary (see
 * lib/gujaratBoundary.ts), not a bounding rectangle -- a point just outside
 * the coastline but inside the bbox (open sea, a sliver of Rajasthan) is
 * correctly excluded. The bbox check runs first purely as a fast reject;
 * it never widens what counts as "in Gujarat," only narrows the candidates
 * that need the real per-ring test. */
export function isWithinGujarat(lat: number, long: number): boolean {
  if (lat < GUJARAT_BOUNDS.south || lat > GUJARAT_BOUNDS.north) return false;
  if (long < GUJARAT_BOUNDS.west || long > GUJARAT_BOUNDS.east) return false;
  return GUJARAT_BOUNDARY_RINGS.some((ring) => pointInRing(lat, long, ring));
}

// Standard Web Mercator meters-per-pixel constant (equatorial
// circumference in meters / 256px tile, halved per zoom level) -- the same
// formula used by Leaflet.heat and similar canvas-overlay plugins. Scaled
// by cos(latitude) since a degree of longitude covers fewer real meters
// the further from the equator a point sits.
const EQUATOR_METERS_PER_PIXEL_AT_ZOOM_0 = 156543.03392;

export function metersToPixelRadius(lat: number, zoom: number, meters: number): number {
  const metersPerPixel =
    (EQUATOR_METERS_PER_PIXEL_AT_ZOOM_0 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
  return meters / metersPerPixel;
}
