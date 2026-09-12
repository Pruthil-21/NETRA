// Historical density/flow trends over an arbitrary date range -- see
// backend-watchlist's GET /detections/density/trend and
// GET /detections/flows/trend. Distinct from densityService.ts/
// flowService.ts, which only cover the Map page's live/hour-of-day
// snapshot layers.
import { authHeaders, unauthorizedError, isJwtConfigured } from '@/lib/apiAuth';

const WATCHLIST_API_URL = process.env.NEXT_PUBLIC_WATCHLIST_API_URL || 'http://localhost:8001';

export type TrendBucket = 'hour' | 'day';

export interface TrendPoint {
  bucket_start: string;
  count: number;
}

export interface DensityTrend {
  trend: TrendPoint[];
  top_cameras: { camera_id: number; count: number }[];
}

export interface FlowTrend {
  trend: TrendPoint[];
  top_corridors: { from_camera_id: number; to_camera_id: number; transitions: number; avg_speed_kmh: number | null }[];
}

interface TrendQuery {
  from: string;
  to: string;
  bucket: TrendBucket;
}

async function fetchTrend<T>(path: string, query: TrendQuery, label: string): Promise<T> {
  const params = new URLSearchParams({ from: query.from, to: query.to, bucket: query.bucket });
  const response = await fetch(`${WATCHLIST_API_URL}${path}?${params.toString()}`, {
    headers: authHeaders(),
    cache: 'no-store',
  });
  if (response.status === 401 && !isJwtConfigured()) throw unauthorizedError(label);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.detail || `Failed to ${label}: HTTP ${response.status}`);
  }
  return response.json();
}

export const trafficAnalyticsService = {
  fetchDensityTrend: (query: TrendQuery) =>
    fetchTrend<DensityTrend>('/detections/density/trend', query, 'fetch density trend'),
  fetchFlowTrend: (query: TrendQuery) =>
    fetchTrend<FlowTrend>('/detections/flows/trend', query, 'fetch flow trend'),
};
