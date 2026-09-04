import { Camera } from '@/types/camera';
import { OrganizerCamera } from '@/types/organizerCamera';
import { ORGANIZER_CAMERA_COORDS } from '@/lib/organizerCameraCoords';

// The organizer's live camera API returns no coordinates at all — only a
// free-text `location` label. ORGANIZER_CAMERA_COORDS holds real positions
// geocoded from those labels (see that file for method and confidence per
// camera). A camera id outside that table (e.g. a future addition beyond the
// current 30) falls back to Gujarat's centroid rather than a fabricated spot.
const GUJARAT_CENTER = { lat: 22.2587, long: 71.1924 };

function resolvePosition(id: number, oc: OrganizerCamera): { lat: number; long: number } {
  if (oc.lat != null && oc.long != null) return { lat: oc.lat, long: oc.long };
  const curated = ORGANIZER_CAMERA_COORDS[id];
  return curated ? { lat: curated.lat, long: curated.long } : GUJARAT_CENTER;
}

/**
 * Maps a raw organizer camera into the app's Camera shape so it can flow
 * through the existing registry context, map, markers, and detail drawer
 * unchanged. Fields the organizer API doesn't provide (ownership, storage,
 * retention, camera type) get fixed placeholder values — there's no real
 * data to put there.
 */
export function organizerCameraToCamera(oc: OrganizerCamera): Camera {
  const id = Number(oc.id);
  const { lat, long } = resolvePosition(id, oc);
  // width > 0 is only a preliminary signal from the organizer's transcoder —
  // actual HLS playback success/failure is the final word on live status.
  const hasPreliminarySignal = (oc.width ?? 0) > 0;

  return {
    id,
    name: oc.name || `Camera ${oc.id}`,
    dept: oc.location || 'Unknown location',
    lat,
    long,
    camera_type: 'Bullet',
    ownership: 'Event Organizer',
    connectivity_status: hasPreliminarySignal ? 'online' : 'offline',
    storage_type: 'Cloud',
    retention_days: 0,
    health_status: hasPreliminarySignal ? 'operational' : 'degraded',
    rtsp_url: oc.rtsp_url || '',
    // The organizer API never sets these, so this is unchanged for it
    // (stream_id: id, hls_url: undefined -> numeric HLS URL as before). A
    // manually added camera can set either to point at a real MediaMTX path.
    stream_id: oc.stream_path ?? id,
    hls_url: oc.hls_url ?? null,
    // The organizer API never sets this either; a manually added camera can
    // set it via the Circle dropdown in AddCameraModal.
    circle_id: oc.circleId ?? null,
  };
}
