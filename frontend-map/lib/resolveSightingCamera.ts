import { Camera } from '@/types/camera';
import { Detection } from '@/types/detection';

/**
 * Resolves the Camera to display for one sighting. The frontend's own
 * registry (cameraById) is always authoritative when it has an entry --
 * per Anushka's own note, GET /vehicle-traces' embedded camera_name/
 * latitude/longitude/stream_id are a temporary, hardcoded-server-side stub
 * for cameras 101/102/103, not a permanent data source. Falling back to
 * that embedded metadata only when the registry doesn't have the camera
 * keeps this resilient (still renders a route/pin) without depending on
 * the stub once real camera data exists.
 */
export function resolveSightingCamera(
  detection: Detection,
  cameraById: Map<number, Camera>
): Camera | null {
  const registered = cameraById.get(detection.camera_id);
  if (registered) return registered;

  if (detection.latitude == null || detection.longitude == null) return null;

  return {
    id: detection.camera_id,
    name: detection.camera_name || `Camera #${detection.camera_id}`,
    dept: 'Unknown',
    lat: detection.latitude,
    long: detection.longitude,
    camera_type: 'ANPR',
    ownership: 'Vehicle-Trace Demo (unregistered)',
    connectivity_status: 'offline',
    storage_type: 'Cloud',
    retention_days: 0,
    health_status: 'degraded',
    rtsp_url: '',
    stream_id: detection.stream_id ?? null,
    hls_url: null,
  };
}
