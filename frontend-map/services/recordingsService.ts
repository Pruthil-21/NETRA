import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';

export interface RecordingSegment {
  start: string; // RFC3339
  duration: number; // seconds
  /** Ready-to-use playback link for exactly this segment -- carries a
   * camera/range-scoped token valid for 15 minutes (see
   * backend-registry's recordings_service.py). Hand it straight to a
   * <video> element or a download link; never rebuild a playback URL
   * client-side, only the recording service can mint a valid token. */
  url: string;
}

export interface RecordingsAvailability {
  available: boolean;
  segments: RecordingSegment[];
  /** False whenever the recording service itself couldn't be reached (not
   * configured, connection failed, or this camera has no stream_id at
   * all) -- distinct from `available: false` with `service_reachable: true`,
   * which means the service answered fine but this camera genuinely has no
   * footage in the requested range. Callers should show a different message
   * for each rather than one generic "no recordings" state. */
  service_reachable: boolean;
}

export interface RecordingTimeRange {
  start: string; // RFC3339
  end: string; // RFC3339
}

/** GET /cameras/{id}/recordings -- proxied through to the DIGDHRISHTI
 * continuous-recording service (streaming/recording). `available: false`
 * means either "the service isn't configured/reachable" or "this camera has
 * no recordings in the requested range" -- check `service_reachable` to
 * tell those two apart and show the officer the right message.
 *
 * `range` is optional: omitted, the backend defaults to its own lookback
 * window (today, the last 30 days) -- good enough for "does this camera
 * have any history at all" (the Archive calendar). Pass a tight range to
 * mint a segment covering exactly that window (e.g. exporting a marked
 * clip) -- each returned segment's `url` is only valid for 15 minutes, so
 * don't fetch a wide range and sit on it. */
export async function fetchRecordingSegments(cameraId: number, range?: RecordingTimeRange): Promise<RecordingsAvailability> {
  const qs = range ? `?${new URLSearchParams({ start: range.start, end: range.end }).toString()}` : '';
  const res = await fetch(`${REGISTRY_API_URL}/cameras/${cameraId}/recordings${qs}`, {
    headers: authHeaders(),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Failed to load recordings: HTTP ${res.status}`);
  return res.json();
}

export interface RecordingHealthEvent {
  event_id: string;
  camera_id?: number; // present on WS-pushed events, absent on the REST snapshot (already scoped to one camera)
  camera_name?: string;
  stream_id: string;
  status: string;
  message: string | null;
  occurred_at: string | null;
  received_at?: string; // RFC3339, REST snapshot only
}

/** GET /cameras/{id}/recordings/health-events -- our own local
 * recording_health_events table (populated by the recording service's push
 * webhook), not a call out to the recording service itself. Fast, and
 * never blocked on that service being reachable -- the initial paint for
 * useRecordingHealthEvents, paired with the live WebSocket for updates
 * after that. */
export async function fetchRecordingHealthEvents(cameraId: number, limit = 20): Promise<RecordingHealthEvent[]> {
  const res = await fetch(`${REGISTRY_API_URL}/cameras/${cameraId}/recordings/health-events?limit=${limit}`, {
    headers: authHeaders(),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Failed to load recording health: HTTP ${res.status}`);
  return res.json();
}
