import { Detection, DetectionSearchParams, RawVehicleTraceResponse } from '@/types/detection';
import { authHeaders, unauthorizedError, isJwtConfigured } from '@/lib/apiAuth';
import { plateSimilarity, PLATE_MATCH_THRESHOLD } from '@/lib/plateSimilarity';

// backend-watchlist, not backend-registry -- a separate service/port, see
// NEXT_PUBLIC_WATCHLIST_API_URL in .env.example.
const WATCHLIST_API_URL =
  process.env.NEXT_PUBLIC_WATCHLIST_API_URL || 'http://localhost:8001';

export const detectionService = {
  async search(params: DetectionSearchParams): Promise<Detection[]> {
    // Vehicle-trace demo path: GET /vehicle-traces/{plate}?scenario_run_id=...
    // (Anushka's contract) scopes results to one replay run instead of a
    // plate's whole sighting history. Not yet live server-side as of this
    // writing -- kept as a separate branch so the general /detections path
    // below (the real, permanent contract) is untouched either way.
    if (params.scenario_run_id && params.plate_number) {
      const query = new URLSearchParams({ scenario_run_id: params.scenario_run_id });
      const response = await fetch(
        `${WATCHLIST_API_URL}/vehicle-traces/${encodeURIComponent(params.plate_number)}?${query.toString()}`,
        { headers: authHeaders(), cache: 'no-store' }
      );

      if (response.status === 401 && !isJwtConfigured()) throw unauthorizedError('fetch vehicle trace');
      if (!response.ok) {
        throw new Error(`Failed to fetch vehicle trace: ${response.statusText} (${response.status})`);
      }

      const trace: RawVehicleTraceResponse = await response.json();
      // No per-sighting `id` in this shape -- camera_id is unique within one
      // scenario run's sightings (contract: one confirmed detection per
      // camera per run), so it doubles as a stable React key here.
      return trace.sightings.map((sighting) => ({
        id: sighting.camera_id,
        plate_number: trace.plate,
        camera_id: sighting.camera_id,
        camera_name: sighting.camera_name,
        latitude: sighting.latitude,
        longitude: sighting.longitude,
        stream_id: sighting.stream_id,
        detected_at: sighting.detected_at,
        confidence: sighting.confidence,
        scenario_run_id: trace.scenario_run_id,
        route_label: trace.label,
      }));
    }

    // Deliberately NOT sending plate_number as a server filter: backend-
    // watchlist's GET /detections does exact string matching, but OCR reads
    // the same physical plate differently across cameras (O/0, I/1
    // confusion) -- an exact-match query would silently miss real sightings
    // stored under a different spelling. Fetching the (small, demo-scale)
    // candidate set and fuzzy-matching client-side below is what actually
    // finds every sighting of the searched vehicle.
    const query = new URLSearchParams();
    if (params.camera_id != null) query.set('camera_id', String(params.camera_id));
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);

    const response = await fetch(`${WATCHLIST_API_URL}/detections?${query.toString()}`, {
      headers: authHeaders(),
      cache: 'no-store',
    });

    if (response.status === 401 && !isJwtConfigured()) throw unauthorizedError('search detections');
    if (!response.ok) {
      throw new Error(`Failed to search detections: ${response.statusText} (${response.status})`);
    }

    const all: Detection[] = await response.json();
    if (!params.plate_number) return all;

    const target = params.plate_number.trim().toUpperCase();
    return all.filter(
      (d) => plateSimilarity(d.plate_number.toUpperCase(), target) >= PLATE_MATCH_THRESHOLD
    );
  },
};
