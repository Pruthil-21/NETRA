import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';

export interface Area {
  id: number;
  name: string;
  village_id: number;
  created_at: string;
  // Denormalized by the backend join (areas_service._AREA_SELECT) -- where
  // this area actually is, without a separate villages/talukas/districts
  // lookup per area.
  village: string;
  taluka: string;
  district: string;
  district_id: number;
}

export interface AreaCreateBody {
  name: string;
  village_id: number;
}

export interface AreaUpdateBody {
  name?: string;
  village_id?: number;
}

export interface ListAreasParams {
  villageId?: number;
  search?: string;
}

export const areasService = {
  async listAreas(params: ListAreasParams = {}): Promise<Area[]> {
    const query = new URLSearchParams();
    if (params.villageId != null) query.set('village_id', String(params.villageId));
    if (params.search) query.set('search', params.search);
    const qs = query.toString();
    const res = await fetch(`${REGISTRY_API_URL}/areas${qs ? `?${qs}` : ''}`, {
      headers: authHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Failed to fetch areas: HTTP ${res.status}`);
    return res.json();
  },

  async createArea(body: AreaCreateBody): Promise<Area> {
    const res = await fetch(`${REGISTRY_API_URL}/areas`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to create area: HTTP ${res.status}`);
    return res.json();
  },

  async updateArea(id: number, body: AreaUpdateBody): Promise<Area> {
    const res = await fetch(`${REGISTRY_API_URL}/areas/${id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to update area: HTTP ${res.status}`);
    return res.json();
  },

  async deleteArea(id: number): Promise<void> {
    const res = await fetch(`${REGISTRY_API_URL}/areas/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to delete area: HTTP ${res.status}`);
  },
};
