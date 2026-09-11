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

  /** The one write path for a REAL registry camera's editable fields (the
   * AddCameraModal / manual-camera form is a separate, unrelated
   * localStorage-only path for synthetic "manual" cameras; this hits the
   * actual backend-registry PUT /cameras/{id}, same endpoint every other
   * per-field update below goes through). Uses REGISTRY_API_URL/authHeaders,
   * same as every other real registry call in this app (see
   * services/areasService.ts, CameraRegistryContext.tsx). Throws with the
   * backend's own detail message (e.g. a cross-district rejection) so the
   * caller can surface it instead of a generic "failed" string. */
  async updateCamera(id: number, patch: Partial<Omit<Camera, 'id'>>): Promise<Camera> {
    const response = await fetch(`${REGISTRY_API_URL}/cameras/${id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(patch),
    });
    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json();
        detail = body?.detail ?? '';
      } catch {
        // Non-JSON error body -- fall back to the generic message below.
      }
      throw new Error(detail || `Failed to update camera: HTTP ${response.status}`);
    }
    return response.json();
  },

  /** Permanently removes a real registry camera. Same detail-message
   * convention as updateCamera -- callers surface the backend's own reason
   * rather than a generic failure. */
  async deleteCamera(id: number): Promise<void> {
    const response = await fetch(`${REGISTRY_API_URL}/cameras/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json();
        detail = body?.detail ?? '';
      } catch {
        // Non-JSON error body -- fall back to the generic message below.
      }
      throw new Error(detail || `Failed to delete camera: HTTP ${response.status}`);
    }
  },

  /** Checks whether a video address actually resolves, before a camera row
   * even exists -- backs the Add Camera modal's "Test Connection" button.
   * A real backend call regardless of whether the camera being added ends
   * up as a manual (localStorage-only) or real registry camera: the stream
   * itself lives on the relay either way, so reachability isn't tied to
   * whether a camera row exists for it. */
  async testStream(input: { stream_id?: string; hls_url?: string }): Promise<{ reachable: boolean }> {
    const response = await fetch(`${REGISTRY_API_URL}/cameras/test-stream`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(`Failed to test stream: HTTP ${response.status}`);
    }
    return response.json();
  },
};