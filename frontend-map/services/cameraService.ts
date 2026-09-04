import { Camera } from '@/types/camera';
import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001';

export const cameraService = {
  async getAll(): Promise<Camera[]> {
    const response = await fetch(`${API_BASE_URL}/cameras`, {
      headers: {
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch cameras: ${response.statusText} (${response.status})`);
    }

    return response.json();
  },

  async getById(id: string | number): Promise<Camera> {
    const response = await fetch(`${API_BASE_URL}/cameras/${id}`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch camera details for ID: ${id}`);
    }
    return response.json();
  },

  /** Assigns (or clears, with `circleId: null`) a real registry camera's
   * circle -- the one write path for a REAL camera's circle_id (the
   * AddCameraModal / manual-camera circleId field is a separate, unrelated
   * localStorage-only path for synthetic "manual" cameras; this hits the
   * actual backend-registry PUT /cameras/{id}). Uses REGISTRY_API_URL/
   * authHeaders, same as every other real registry call in this app (see
   * services/circlesService.ts, CameraRegistryContext.tsx). Throws with the
   * backend's own detail message (e.g. a cross-district rejection) so the
   * caller can surface it instead of a generic "failed" string. */
  async updateCameraCircle(id: number, circleId: number | null): Promise<Camera> {
    const response = await fetch(`${REGISTRY_API_URL}/cameras/${id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ circle_id: circleId }),
    });
    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json();
        detail = body?.detail ?? '';
      } catch {
        // Non-JSON error body -- fall back to the generic message below.
      }
      throw new Error(detail || `Failed to update camera's circle: HTTP ${response.status}`);
    }
    return response.json();
  },
};