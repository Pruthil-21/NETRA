// frontend-map/services/adminService.ts
import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';

export interface PostingSummary {
  id: number;
  role: string;
  scope_type: string;
  scope_value: string | null;
}

export interface OfficerOut {
  id: number;
  badge_number: string;
  name: string;
  rank: string | null;
  active_posting: PostingSummary | null;
}

export interface PostingCreateBody {
  officer_id: number;
  role_name: string;
  scope_type: string;
  scope_value: string | null;
}

export interface RolePermissionsOut {
  name: string;
  display_name: string;
  hierarchy_level: number | null;
  permissions: string[];
}

export const adminService = {
  async listOfficers(): Promise<OfficerOut[]> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/officers`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch officers: HTTP ${res.status}`);
    return res.json();
  },

  async reassignPosting(body: PostingCreateBody): Promise<PostingSummary> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/postings`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to reassign posting: HTTP ${res.status}`);
    return res.json();
  },

  async getRoles(): Promise<RolePermissionsOut[]> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/roles`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch roles: HTTP ${res.status}`);
    return res.json();
  },

  async updateRolePermissions(roleName: string, permissions: string[], reasonCode?: string): Promise<RolePermissionsOut> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/roles/${roleName}/permissions`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ permissions, reason_code: reasonCode }),
    });
    if (!res.ok) throw new Error(`Failed to update role permissions: HTTP ${res.status}`);
    return res.json();
  },
};
