import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';
import { ScaleCameraPage, ScaleSummary, BoundingBox, DistrictCount } from '@/types/scaleCamera';

interface ListPageParams {
  cursor?: number;
  limit?: number;
  bbox?: BoundingBox;
}

function bboxParams(bbox: BoundingBox): Record<string, string> {
  return {
    min_lat: String(bbox.minLat),
    max_lat: String(bbox.maxLat),
    min_long: String(bbox.minLong),
    max_long: String(bbox.maxLong),
  };
}

// Every scaleCameraService method that hits the network calls notifyApiRequest()
// exactly once per real fetch -- the one place in this codebase's structure
// that legitimately knows about every API call this page makes, so metrics
// (Task 14) can count them accurately without every consuming component
// having to remember to report its own fetches individually.
type RequestListener = () => void;
let requestListeners: RequestListener[] = [];

export function onScaleApiRequest(listener: RequestListener): () => void {
  requestListeners.push(listener);
  return () => {
    requestListeners = requestListeners.filter((l) => l !== listener);
  };
}

function notifyApiRequest(): void {
  requestListeners.forEach((listener) => listener());
}

export const scaleCameraService = {
  async listPage({ cursor, limit = 200, bbox }: ListPageParams = {}, signal?: AbortSignal): Promise<ScaleCameraPage> {
    const params = new URLSearchParams({ include_synthetic: 'true', limit: String(limit) });
    if (cursor !== undefined) params.set('cursor', String(cursor));
    if (bbox) {
      for (const [key, value] of Object.entries(bboxParams(bbox))) params.set(key, value);
    }
    notifyApiRequest();
    const res = await fetch(`${REGISTRY_API_URL}/cameras?${params.toString()}`, { headers: authHeaders(), signal });
    if (!res.ok) throw new Error(`Failed to fetch camera page: HTTP ${res.status}`);
    return res.json();
  },

  async getDistrictSummary(bbox: BoundingBox, signal?: AbortSignal): Promise<DistrictCount[]> {
    // A real SQL GROUP BY on the backend (Task 4) -- not a client-side count
    // over one page, which would under-report any district bigger than a
    // single page.
    const params = new URLSearchParams({ group_by: 'district', ...bboxParams(bbox) });
    notifyApiRequest();
    const res = await fetch(`${REGISTRY_API_URL}/cameras/summary?${params.toString()}`, { headers: authHeaders(), signal });
    if (!res.ok) throw new Error(`Failed to fetch district summary: HTTP ${res.status}`);
    const body = await res.json();
    return body.districts;
  },

  async getSummary(): Promise<ScaleSummary> {
    notifyApiRequest();
    const res = await fetch(`${REGISTRY_API_URL}/cameras/summary`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch camera summary: HTTP ${res.status}`);
    return res.json();
  },
};
