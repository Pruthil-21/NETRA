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
  active_postings: PostingSummary[];
}

export interface PostingCreateBody {
  officer_id: number;
  role_name: string;
  scope_type: string;
  scope_value: string | null;
}

export interface RolePermissionsOut {
  id: number;
  name: string;
  display_name: string;
  hierarchy_level: number | null;
  permissions: string[];
  parent_role_id: number | null;
  is_active: boolean;
  is_system: boolean;
  duty_ids: number[];
}

export interface AuditLogOut {
  id: number;
  badge_number: string | null;
  action: string;
  resource_type: string;
  resource_id: number | null;
  reason_code: string | null;
  timestamp: string;
  category: string;
  actor_name: string | null;
  camera_name: string | null;
  camera_district: string | null;
  camera_area: string | null;
}

export interface AuditLogsPage {
  logs: AuditLogOut[];
  next_cursor: number | null;
}

export interface AuditLogsQuery {
  badge_number?: string;
  resource_type?: string;
  category?: string;
  camera_id?: number;
  camera_district?: string;
  camera_area_id?: number;
  from?: string;
  to?: string;
  cursor?: number;
}

export interface RegistrationRequestOut {
  id: number;
  officer_id: number;
  badge_number: string;
  name: string;
  rank: string | null;
  department: string | null;
  contact_info: string | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  created_at: string;
}

export interface OfficerProfileOut {
  id: number;
  badge_number: string;
  name: string;
  rank: string | null;
  photo_url: string | null;
  status: string;
  last_login_at: string | null;
  recent_logins: string[];
  active_postings: PostingSummary[];
}

export interface DutyOut {
  id: number;
  name: string;
  display_name: string;
  description: string | null;
  permissions: string[];
}

export interface RoleOut {
  id: number;
  name: string;
  display_name: string;
  hierarchy_level: number | null;
  can_delegate_admin: boolean;
  parent_role_id: number | null;
  is_active: boolean;
  is_system: boolean;
  duty_ids: number[];
  permissions: string[];
}

export interface NotificationOut {
  id: number;
  officer_id: number;
  type: string;
  message: string;
  read: boolean;
  created_at: string;
}

export const adminService = {
  async listOfficers(): Promise<OfficerOut[]> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/officers`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch officers: HTTP ${res.status}`);
    return res.json();
  },

  async resetOfficerPassword(officerId: number, newPassword: string): Promise<void> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/officers/${officerId}/reset-password`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ new_password: newPassword }),
    });
    if (!res.ok) throw new Error(`Failed to reset password: HTTP ${res.status}`);
  },

  async reassignPosting(body: PostingCreateBody): Promise<PostingSummary> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/postings`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.detail || `Failed to reassign posting: HTTP ${res.status}`);
    }
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

  async listAuditLogs(query: AuditLogsQuery = {}): Promise<AuditLogsPage> {
    const params = new URLSearchParams();
    if (query.badge_number) params.set('badge_number', query.badge_number);
    if (query.resource_type) params.set('resource_type', query.resource_type);
    if (query.category) params.set('category', query.category);
    if (query.camera_id != null) params.set('camera_id', String(query.camera_id));
    if (query.camera_district) params.set('camera_district', query.camera_district);
    if (query.camera_area_id != null) params.set('camera_area_id', String(query.camera_area_id));
    if (query.from) params.set('from', query.from);
    if (query.to) params.set('to', query.to);
    if (query.cursor != null) params.set('cursor', String(query.cursor));
    const qs = params.toString();
    const res = await fetch(`${REGISTRY_API_URL}/audit-logs${qs ? `?${qs}` : ''}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch audit logs: HTTP ${res.status}`);
    return res.json();
  },

  async listAuditLogCategories(): Promise<string[]> {
    const res = await fetch(`${REGISTRY_API_URL}/audit-logs/categories`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch audit log categories: HTTP ${res.status}`);
    const body = await res.json();
    return body.categories;
  },

  async listApprovals(status?: string): Promise<RegistrationRequestOut[]> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    const res = await fetch(`${REGISTRY_API_URL}/admin/approvals${qs}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch approvals: HTTP ${res.status}`);
    return res.json();
  },

  async approveRegistration(
    requestId: number, roleName: string, scopeType: string, scopeValue: string | null
  ): Promise<RegistrationRequestOut> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/approvals/${requestId}/approve`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ role_name: roleName, scope_type: scopeType, scope_value: scopeValue }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.detail || `Failed to approve registration: HTTP ${res.status}`);
    }
    return res.json();
  },

  async rejectRegistration(requestId: number, reason?: string): Promise<RegistrationRequestOut> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/approvals/${requestId}/reject`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) throw new Error(`Failed to reject registration: HTTP ${res.status}`);
    return res.json();
  },

  async getOfficerProfile(officerId: number): Promise<OfficerProfileOut> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/officers/${officerId}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch officer profile: HTTP ${res.status}`);
    return res.json();
  },

  async suspendOfficer(officerId: number): Promise<void> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/officers/${officerId}/suspend`, {
      method: 'POST', headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to suspend officer: HTTP ${res.status}`);
  },

  async reactivateOfficer(officerId: number): Promise<void> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/officers/${officerId}/reactivate`, {
      method: 'POST', headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to reactivate officer: HTTP ${res.status}`);
  },

  async forceLogoutOfficer(officerId: number): Promise<void> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/officers/${officerId}/force-logout`, {
      method: 'POST', headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to force-logout officer: HTTP ${res.status}`);
  },

  async unlockOfficer(officerId: number): Promise<void> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/officers/${officerId}/unlock`, {
      method: 'POST', headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to unlock officer: HTTP ${res.status}`);
  },

  async revokePosting(postingId: number): Promise<void> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/postings/${postingId}`, {
      method: 'DELETE', headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to revoke posting: HTTP ${res.status}`);
  },

  async listDuties(): Promise<DutyOut[]> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/duties`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch duties: HTTP ${res.status}`);
    return res.json();
  },

  async createDuty(name: string, displayName: string, permissions: string[], description?: string): Promise<DutyOut> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/duties`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name, display_name: displayName, description, permissions }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.detail || `Failed to create duty: HTTP ${res.status}`);
    }
    return res.json();
  },

  async updateDuty(dutyId: number, displayName: string, permissions: string[], description?: string): Promise<DutyOut> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/duties/${dutyId}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ display_name: displayName, description, permissions }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.detail || `Failed to update duty: HTTP ${res.status}`);
    }
    return res.json();
  },

  async deleteDuty(dutyId: number): Promise<void> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/duties/${dutyId}`, {
      method: 'DELETE', headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.detail || `Failed to delete duty: HTTP ${res.status}`);
    }
  },

  async updateRoleDuties(roleId: number, dutyIds: number[]): Promise<RoleOut> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/roles/${roleId}/duties`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ duty_ids: dutyIds }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.detail || `Failed to update role duties: HTTP ${res.status}`);
    }
    return res.json();
  },

  async createRole(body: {
    name: string; display_name: string; hierarchy_level?: number | null;
    can_delegate_admin?: boolean; parent_role_id?: number | null; duty_ids?: number[]; permissions?: string[];
  }): Promise<RoleOut> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/roles`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      throw new Error(errBody?.detail || `Failed to create role: HTTP ${res.status}`);
    }
    return res.json();
  },

  async cloneRole(roleId: number, name: string, displayName: string): Promise<RoleOut> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/roles/${roleId}/clone`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name, display_name: displayName }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.detail || `Failed to clone role: HTTP ${res.status}`);
    }
    return res.json();
  },

  async deactivateRole(roleId: number): Promise<RoleOut> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/roles/${roleId}/deactivate`, {
      method: 'POST', headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to deactivate role: HTTP ${res.status}`);
    return res.json();
  },

  async reactivateRole(roleId: number): Promise<RoleOut> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/roles/${roleId}/reactivate`, {
      method: 'POST', headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to reactivate role: HTTP ${res.status}`);
    return res.json();
  },

  async deleteRole(roleId: number): Promise<void> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/roles/${roleId}`, {
      method: 'DELETE', headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.detail || `Failed to delete role: HTTP ${res.status}`);
    }
  },

  async listNotifications(unreadOnly = false): Promise<NotificationOut[]> {
    const qs = unreadOnly ? '?unread_only=true' : '';
    const res = await fetch(`${REGISTRY_API_URL}/notifications${qs}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch notifications: HTTP ${res.status}`);
    return res.json();
  },

  async markNotificationRead(notificationId: number): Promise<void> {
    const res = await fetch(`${REGISTRY_API_URL}/notifications/${notificationId}/read`, {
      method: 'POST', headers: authHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to mark notification read: HTTP ${res.status}`);
  },
};
