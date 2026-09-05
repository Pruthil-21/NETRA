import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';

export interface RecordingSegment {
  start: string; // RFC3339
  duration: number; // seconds
}

export interface RecordingsAvailability {
  available: boolean;
  segments: RecordingSegment[];
}

/** GET /cameras/{id}/recordings -- backed by MediaMTX's Playback API (see
 * streaming/README.md's "Recorded footage / VOD playback" section).
 * `available: false` covers both "playback server isn't running" and "this
 * camera has no recordings yet" -- the timeline shows the same quiet empty
 * state either way. */
export async function fetchRecordingSegments(cameraId: number): Promise<RecordingsAvailability> {
  const res = await fetch(`${REGISTRY_API_URL}/cameras/${cameraId}/recordings`, {
    headers: authHeaders(),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Failed to load recordings: HTTP ${res.status}`);
  return res.json();
}
