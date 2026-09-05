'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Save, ShieldCheck } from 'lucide-react';
import { adminService, RolePermissionsOut } from '@/services/adminService';
import { roleBadgeClass } from './roleBadge';

// The platform's full permission catalog (Task 1/10) -- every role's grant
// set is a subset of this list. Kept in the same display order the backend
// seeds them in, so the checkbox grid reads consistently across roles.
const ALL_PERMISSIONS = [
  'view_live_feeds',
  'search_vehicles',
  'edit_watchlist',
  'manage_cameras',
  'view_analytics',
  'export_data',
  'manage_users_roles',
  'view_audit_logs',
  'acknowledge_alerts',
  'manage_roles',
  'manage_stations',
  'manage_circles',
  'reset_officer_passwords',
];

// Humanized labels shown alongside each checkbox for readability -- the
// aria-label stays the raw permission string so it stays a stable, testable
// contract with the backend's permission names.
const PERMISSION_LABELS: Record<string, string> = {
  view_live_feeds: 'View Live Feeds',
  search_vehicles: 'Search Vehicles',
  edit_watchlist: 'Edit Watchlist',
  manage_cameras: 'Manage Cameras',
  view_analytics: 'View Analytics',
  export_data: 'Export Data',
  manage_users_roles: 'Manage Users & Roles',
  view_audit_logs: 'View Audit Logs',
  acknowledge_alerts: 'Acknowledge Alerts',
  manage_roles: 'Manage Roles',
  manage_stations: 'Manage Police Stations',
  manage_circles: 'Manage Circles',
  reset_officer_passwords: "Reset Officers' Passwords",
};

/** Role-permission editor -- only rendered for a Super Admin (the
 * `manage_roles` gate lives in the caller). Lets them redefine what each
 * role can do platform-wide; distinct from the officer/posting flow, which
 * only reassigns individual officers *into* existing roles. */
export function RolePermissionsSection() {
  const [roles, setRoles] = useState<RolePermissionsOut[]>([]);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [reasonCodes, setReasonCodes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingRole, setSavingRole] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ role: string; message: string } | null>(null);
  const [savedRole, setSavedRole] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setLoadError(null);
    adminService
      .getRoles()
      .then((data) => {
        setRoles(data);
        setDraft(Object.fromEntries(data.map((r) => [r.name, [...r.permissions]])));
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load roles'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const toggle = (roleName: string, permission: string) => {
    setDraft((prev) => {
      const current = prev[roleName] ?? [];
      const next = current.includes(permission)
        ? current.filter((p) => p !== permission)
        : [...current, permission];
      return { ...prev, [roleName]: next };
    });
  };

  const save = async (roleName: string) => {
    setSavingRole(roleName);
    setSaveError(null);
    setSavedRole(null);
    try {
      const updated = await adminService.updateRolePermissions(
        roleName,
        draft[roleName] ?? [],
        reasonCodes[roleName] || undefined,
      );
      setRoles((prev) => prev.map((r) => (r.name === roleName ? updated : r)));
      setSavedRole(roleName);
    } catch (err) {
      setSaveError({
        role: roleName,
        message: err instanceof Error ? err.message : 'Failed to update role permissions',
      });
    } finally {
      setSavingRole(null);
    }
  };

  return (
    <section>
      <div className="flex items-center gap-3 mb-1">
        <span className="inline-flex p-2 bg-signal-red/10 border border-signal-red/30 text-signal-red rounded-lg">
          <ShieldCheck size={18} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide">Role Permissions</h2>
          <p className="text-[11px] text-slate-500">Redefine what each role is permitted to do, platform-wide</p>
        </div>
      </div>

      <div className="mt-6">
        {loadError && (
          <div className="flex items-start gap-2.5 p-3 mb-4 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-semibold">Failed to load roles</p>
              <p className="text-[11px] text-signal-red/80">{loadError}</p>
            </div>
            <button
              type="button"
              onClick={load}
              className="ml-auto shrink-0 text-[11px] px-2.5 py-1 rounded bg-panel-raised border border-line text-slate-200 hover:text-white"
            >
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col gap-2.5 animate-pulse" aria-label="Loading roles">
            {[1, 2].map((item) => (
              <div key={item} className="border border-line rounded-lg bg-panel p-4 h-[140px]">
                <div className="h-5 w-32 bg-panel-raised rounded-full mb-3" />
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {[1, 2, 3, 4, 5, 6].map((cell) => (
                    <div key={cell} className="h-3 bg-panel-raised rounded w-3/4" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : !loadError && roles.length === 0 ? (
          <div className="flex flex-col items-center text-center gap-2 py-16 text-slate-500">
            <ShieldCheck size={28} className="text-slate-600" />
            <p className="text-xs font-semibold text-slate-400">No roles found</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 max-w-3xl">
            {roles.map((role) => (
              <div key={role.name} className="border border-line rounded-lg bg-panel p-4">
                <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wider ${roleBadgeClass(
                        role.name
                      )}`}
                    >
                      {role.display_name}
                    </span>
                    {role.hierarchy_level != null && (
                      <span className="text-[11px] text-slate-600">Level {role.hierarchy_level}</span>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-2">
                  {ALL_PERMISSIONS.map((permission) => (
                    <label
                      key={permission}
                      className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none"
                    >
                      <input
                        type="checkbox"
                        aria-label={permission}
                        checked={(draft[role.name] ?? []).includes(permission)}
                        onChange={() => toggle(role.name, permission)}
                        className="accent-command w-3.5 h-3.5 shrink-0"
                      />
                      {PERMISSION_LABELS[permission] ?? permission}
                    </label>
                  ))}
                </div>

                {saveError?.role === role.name && (
                  <p className="mt-3 text-[11px] text-signal-red flex items-center gap-1.5">
                    <AlertTriangle size={12} className="shrink-0" />
                    {saveError.message}
                  </p>
                )}

                {savedRole === role.name && (
                  <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-md border border-signal-green/30 bg-signal-green/10 text-signal-green text-[11px]">
                    <CheckCircle2 size={14} />
                    Permissions updated.
                  </div>
                )}

                <div className="flex flex-col sm:flex-row sm:items-center gap-2 mt-3.5 pt-3.5 border-t border-line">
                  <div className="flex-1">
                    <label
                      htmlFor={`reason-${role.name}`}
                      className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1"
                    >
                      Reason Code (optional)
                    </label>
                    <input
                      id={`reason-${role.name}`}
                      value={reasonCodes[role.name] ?? ''}
                      onChange={(e) =>
                        setReasonCodes((prev) => ({ ...prev, [role.name]: e.target.value }))
                      }
                      placeholder="SCOPE_REDUCTION"
                      className="w-full sm:max-w-xs bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={savingRole === role.name}
                    onClick={() => save(role.name)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command self-start sm:self-auto"
                  >
                    {savingRole === role.name ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Save size={12} />
                    )}
                    Save
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default RolePermissionsSection;
