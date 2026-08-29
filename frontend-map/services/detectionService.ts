import { Detection, DetectionSearchParams } from '@/types/detection';

// backend-watchlist, not backend-registry -- a separate service/port, see
// NEXT_PUBLIC_WATCHLIST_API_URL in .env.example.
const WATCHLIST_API_URL =
  process.env.NEXT_PUBLIC_WATCHLIST_API_URL || 'http://localhost:8001';

// GET /detections is officer-role JWT-gated per contract/API_CONTRACT.md.
// frontend-map still has no real login flow (only a `netra_authenticated`
// localStorage flag) -- this is a demo-only stand-in until one exists: a
// pre-issued token dropped in via env, not something frontend-map mints or
// validates itself. Leave unset and this cleanly no-ops (no Authorization
// header sent, same as before) rather than send a garbage token.
const DEMO_OFFICER_JWT = process.env.NEXT_PUBLIC_DEMO_OFFICER_JWT;

export const detectionService = {
  async search(params: DetectionSearchParams): Promise<Detection[]> {
    const query = new URLSearchParams();
    if (params.plate_number) query.set('plate_number', params.plate_number);
    if (params.camera_id != null) query.set('camera_id', String(params.camera_id));
    if (params.from) query.set('from', params.from);
    if (params.to) query.set('to', params.to);

    const response = await fetch(`${WATCHLIST_API_URL}/detections?${query.toString()}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(DEMO_OFFICER_JWT ? { Authorization: `Bearer ${DEMO_OFFICER_JWT}` } : {}),
      },
      cache: 'no-store',
    });

    if (response.status === 401 && !DEMO_OFFICER_JWT) {
      throw new Error(
        'Failed to search detections: 401 Unauthorized (no demo JWT configured — set NEXT_PUBLIC_DEMO_OFFICER_JWT)'
      );
    }

    if (!response.ok) {
      throw new Error(`Failed to search detections: ${response.statusText} (${response.status})`);
    }

    return response.json();
  },
};
