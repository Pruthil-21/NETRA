import { authHeaders, unauthorizedError, isJwtConfigured } from '@/lib/apiAuth';

// backend-watchlist, same service/port detectionService.ts and
// densityService.ts call.
const WATCHLIST_API_URL = process.env.NEXT_PUBLIC_WATCHLIST_API_URL || 'http://localhost:8001';

export interface CorridorFlow {
  from_camera_id: number;
  to_camera_id: number;
  transitions: number;
  avg_speed_kmh: number | null;
  /** Road-following [lat, lon] path between the two cameras (OSRM, cached
   * server-side) -- null when no route could be resolved, in which case
   * FlowCanvasLayer falls back to a straight line between the endpoints. */
  route: [number, number][] | null;
}

export type FlowQuery = { mode: 'live'; windowMinutes: number } | { mode: 'hour'; hour: number };

/** Camera-to-camera transition volume and average speed for the Map
 * page's Flow layer -- exactly one of a rolling live window or an
 * hour-of-day bucket (see backend-watchlist's GET /detections/flows). */
export async function fetchFlows(query: FlowQuery): Promise<CorridorFlow[]> {
  const params = new URLSearchParams();
  if (query.mode === 'live') {
    params.set('window_minutes', String(query.windowMinutes));
  } else {
    params.set('hour', String(query.hour));
  }

  const response = await fetch(`${WATCHLIST_API_URL}/detections/flows?${params.toString()}`, {
    headers: authHeaders(),
    cache: 'no-store',
  });

  if (response.status === 401 && !isJwtConfigured()) throw unauthorizedError('fetch camera flows');
  if (!response.ok) {
    throw new Error(`Failed to fetch camera flows: ${response.statusText} (${response.status})`);
  }

  return response.json();
}
