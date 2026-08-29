import { Detection, DetectionSearchParams } from '@/types/detection';

// backend-watchlist, not backend-registry -- a separate service/port, see
// NEXT_PUBLIC_WATCHLIST_API_URL in .env.example.
const WATCHLIST_API_URL =
  process.env.NEXT_PUBLIC_WATCHLIST_API_URL || 'http://localhost:8001';

export const detectionService = {
  // GET /detections is officer-role JWT-gated per contract/API_CONTRACT.md,
  // but frontend-map has no real JWT auth wired up yet (only a
  // `netra_authenticated` localStorage flag) -- sends no Authorization
  // header, same as cameraService.ts does today. A 401 here is a real,
  // pre-existing gap for P2/P6 to close, not something to fake around.
  async search(params: DetectionSearchParams): Promise<Detection[]> {
    const query = new URLSearchParams();
    if (params.plate_number) query.set('plate_number', params.plate_number);
    if (params.camera_id != null) query.set('camera_id', String(params.camera_id));
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);

    const response = await fetch(`${WATCHLIST_API_URL}/detections?${query.toString()}`, {
      headers: {
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Failed to search detections: ${response.statusText} (${response.status})`);
    }

    return response.json();
  },
};
