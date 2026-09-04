import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';

export interface Circle {
  id: number;
  name: string;
  district: string;
  created_at: string;
}

export interface CircleCreateBody {
  name: string;
  district: string;
}

export interface CircleUpdateBody {
  name?: string;
  district?: string;
}

export const circlesService = {
  async listCircles(): Promise<Circle[]> {
    const res = await fetch(`${REGISTRY_API_URL}/circles`, { headers: authHeaders(), cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to fetch circles: HTTP ${res.status}`);
    return res.json();
  },

  async createCircle(body: CircleCreateBody): Promise<Circle> {
    const res = await fetch(`${REGISTRY_API_URL}/circles`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to create circle: HTTP ${res.status}`);
    return res.json();
  },

  async updateCircle(id: number, body: CircleUpdateBody): Promise<Circle> {
    const res = await fetch(`${REGISTRY_API_URL}/circles/${id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to update circle: HTTP ${res.status}`);
    return res.json();
  },

  async deleteCircle(id: number): Promise<void> {
    const res = await fetch(`${REGISTRY_API_URL}/circles/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to delete circle: HTTP ${res.status}`);
  },
};
