import { Camera } from '@/types/camera';
import { Detection } from '@/types/detection';
import { resolveSightingCamera } from './resolveSightingCamera';
import { classifyLegAnomaly, legBearingAndSpeed } from './geo';

export interface ResolvedSighting {
  sighting: Detection;
  camera: Camera;
  /** Inferred direction/speed of the leg from the previous stop to this one
   * -- undefined for the first stop. Trusts the backend's own value when
   * the sighting already carries one (GET /vehicle-traces' scripted-replay
   * path, audited server-side -- see backend-watchlist's geo.py), and
   * computes it client-side otherwise so a normal plate search (GET
   * /detections, camera resolved from the frontend's own registry) gets
   * the identical feature instead of a lesser version of it. */
  bearingDeg?: number;
  speedKmh?: number | null;
  /** "improbable_speed" / "extended_gap" when this leg trips a heuristic --
   * see geo.classifyLegAnomaly. A flag, never proof of anything on its own. */
  anomaly?: string | null;
}

/** Single source of truth for "sightings, oldest-first, with camera resolved" --
 * shared by CameraMap (route line/markers) and TrajectoryTimeline (scrubber),
 * so the Nth stop on the scrubber is always the Nth point on the map. Computing
 * this separately in each component with the same sort/filter would still
 * agree today, but only by both sides happening to redo the same logic; a
 * silent divergence there is a wrong-camera-shown-for-this-timestamp bug this
 * shared helper rules out entirely. */
export function buildSightingRoute(sightings: Detection[], cameras: Camera[]): ResolvedSighting[] {
  const cameraById = new Map(cameras.map((cam) => [cam.id, cam]));
  const points = sightings
    .slice()
    .sort((a, b) => new Date(a.detected_at).getTime() - new Date(b.detected_at).getTime())
    .map((sighting) => {
      const camera = resolveSightingCamera(sighting, cameraById);
      return camera ? { sighting, camera } : null;
    })
    .filter((point): point is { sighting: Detection; camera: Camera } => point !== null);

  return points.map((point, index) => {
    if (point.sighting.bearing_deg != null) {
      return {
        ...point,
        bearingDeg: point.sighting.bearing_deg,
        speedKmh: point.sighting.speed_kmh,
        anomaly: point.sighting.anomaly,
      };
    }
    if (index === 0) return point;

    const prevCamera = points[index - 1].camera;
    const { bearingDeg, speedKmh, gapHours } = legBearingAndSpeed(
      { lat: prevCamera.lat, lon: prevCamera.long ?? 0, detectedAt: points[index - 1].sighting.detected_at },
      { lat: point.camera.lat, lon: point.camera.long ?? 0, detectedAt: point.sighting.detected_at }
    );
    return { ...point, bearingDeg, speedKmh, anomaly: classifyLegAnomaly(speedKmh, gapHours) };
  });
}
