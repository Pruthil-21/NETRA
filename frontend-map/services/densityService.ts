import { authHeaders, unauthorizedError, isJwtConfigured } from '@/lib/apiAuth';

// backend-watchlist, same service/port detectionService.ts calls.
const WATCHLIST_API_URL = process.env.NEXT_PUBLIC_WATCHLIST_API_URL || 'http://localhost:8001';

export interface DensityPoint {
  camera_id: number;
  count: number;
}

export type DensityQuery =
  | { mode: 'live'; windowMinutes: number }
  | { mode: 'hour'; hour: number };

/** Per-camera detection counts for the Map page's density layer -- exactly
 * one of a rolling live window or an hour-of-day bucket (see
 * backend-watchlist's GET /detections/density). Cameras with zero
 * detections in the window are simply absent from the result. */
export async function fetchDensity(query: DensityQuery): Promise<DensityPoint[]> {
  const params = new URLSearchParams();
  if (query.mode === 'live') {
    params.set('window_minutes', String(query.windowMinutes));
  } else {
    params.set('hour', String(query.hour));
  }

  const response = await fetch(`${WATCHLIST_API_URL}/detections/density?${params.toString()}`, {
    headers: authHeaders(),
    cache: 'no-store',
  });

  if (response.status === 401 && !isJwtConfigured()) throw unauthorizedError('fetch camera density');
  if (!response.ok) {
    throw new Error(`Failed to fetch camera density: ${response.statusText} (${response.status})`);
  }

  return response.json();
}
