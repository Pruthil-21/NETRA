// Client-side display metadata for the platform's fixed permission catalog
// (backend/app/services/rbac_service.py VALID_PERMISSIONS) -- the backend
// only knows these as plain strings, so the human label/module/description
// shown in Security Configuration lives here, not in an API response.
export interface PermissionMeta {
  label: string;
  module: string;
  description: string;
}

export const PERMISSION_META: Record<string, PermissionMeta> = {
  view_live_feeds: { label: 'View Live Feeds', module: 'Operations', description: 'Watch live camera streams on the dashboard and map' },
  search_vehicles: { label: 'Search Vehicles', module: 'Operations', description: 'Search vehicle sightings by number plate' },
  edit_watchlist: { label: 'Edit Watchlist', module: 'Watchlist', description: 'Add or remove blacklist/watchlist entries' },
  manage_cameras: { label: 'Manage Cameras', module: 'Registry', description: 'Create, edit, and delete camera registry entries' },
  view_analytics: { label: 'View Analytics', module: 'Reports', description: 'View analytics and reporting dashboards' },
  export_data: { label: 'Export Data', module: 'Reports', description: 'Export reports and data extracts' },
  manage_users_roles: { label: 'Manage Users & Roles', module: 'Admin', description: 'Assign postings and manage officer accounts' },
  view_audit_logs: { label: 'View Audit Logs', module: 'Admin', description: 'View the platform-wide audit trail' },
  acknowledge_alerts: { label: 'Acknowledge Alerts', module: 'Alerts', description: 'Acknowledge, dismiss, or escalate alerts' },
  manage_roles: { label: 'Manage Roles', module: 'Admin', description: 'Create, edit, and delete roles and their permissions' },
  manage_stations: { label: 'Manage Police Stations', module: 'Registry', description: 'Create, edit, and delete police station records' },
  manage_areas: { label: 'Manage Areas', module: 'Registry', description: 'Create, edit, and delete area records' },
  reset_officer_passwords: { label: "Reset Officers' Passwords", module: 'Admin', description: "Directly reset another officer's password" },
};

export const ALL_PERMISSIONS = Object.keys(PERMISSION_META);

export function permissionLabel(permission: string): string {
  return PERMISSION_META[permission]?.label ?? permission;
}
