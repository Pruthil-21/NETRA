'use client';

import React, { useEffect, useState } from 'react';
import {
  Users,
  UserCog,
  ArrowLeftRight,
  Loader2,
  AlertTriangle,
  X,
  CheckCircle2,
  MapPin,
  ShieldCheck,
  Save,
  KeyRound,
} from 'lucide-react';
import { adminService, OfficerOut, RolePermissionsOut } from '@/services/adminService';
import { usePermissions } from '@/hooks/usePermissions';
import { CircleManagementSection } from './CircleManagementSection';
import { AuditLogSection } from './AuditLogSection';

const ASSIGNABLE_ROLES = ['district_command', 'station_officer', 'control_room_operator', 'auditor'];

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

// Subtle per-role accent so a district commander can tell postings apart at a
// glance in a long roster -- same pill shape for every role (a full theming
// system would be overkill for five roles), just a different accent color.
const ROLE_BADGE_CLASS: Record<string, string> = {
  super_admin: 'bg-signal-red/10 text-signal-red border-signal-red/30',
  district_command: 'bg-command/10 text-command border-command/30',
  station_officer: 'bg-signal-amber/10 text-signal-amber border-signal-amber/30',
  control_room_operator: 'bg-signal-green/10 text-signal-green border-signal-green/30',
  auditor: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
};

function roleBadgeClass(role: string): string {
  return ROLE_BADGE_CLASS[role] ?? 'bg-panel-raised text-slate-300 border-line';
}

/** Role-permission editor -- only rendered for a Super Admin (the
 * `manage_roles` gate lives in the caller). Lets them redefine what each
 * role can do platform-wide; distinct from the officer/posting flow above,
 * which only reassigns individual officers *into* existing roles. */
function RolePermissionsSection() {
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
    <section className="mt-8">
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

/** Admin console -- District Command / Super Admin officers reassign
 * postings here. Nav, auth, and the global header live in the shared
 * AppShell (gated by usePermissions()'s manage_users_roles check); this
 * page owns only the officer roster and the reassignment flow. The backend
 * (Task 4) is the actual authority on the delegated-admin boundary -- this
 * UI's job is to make the common case pleasant, not to be the security
 * boundary itself. */
export default function AdminPage() {
  const { permissions, role, scopeValue, loading: permissionsLoading } = usePermissions();
  const canManageUsers = permissions.includes('manage_users_roles');
  const [officers, setOfficers] = useState<OfficerOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reassigningId, setReassigningId] = useState<number | null>(null);
  const [newRole, setNewRole] = useState('station_officer');
  const [newScopeValue, setNewScopeValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmedFor, setConfirmedFor] = useState<number | null>(null);

  const canResetPasswords = permissions.includes('reset_officer_passwords');
  const [resettingId, setResettingId] = useState<number | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetConfirmedFor, setResetConfirmedFor] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    adminService
      .listOfficers()
      .then(setOfficers)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load officers'))
      .finally(() => setLoading(false));
  };

  // Waits on permissions to resolve first -- an Auditor (view_audit_logs
  // only, never manage_users_roles) hitting this page shouldn't fire a
  // request the backend will 403 just to render an error banner for a
  // section they were never meant to see.
  useEffect(() => {
    if (permissionsLoading || !canManageUsers) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionsLoading, canManageUsers]);

  const openReassign = (officerId: number) => {
    setReassigningId(officerId);
    setSubmitError(null);
    setConfirmedFor(null);
  };

  const closeReassign = () => {
    setReassigningId(null);
    setSubmitError(null);
    setNewRole('station_officer');
    setNewScopeValue('');
  };

  const handleConfirmReassignment = async (officerId: number) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await adminService.reassignPosting({
        officer_id: officerId,
        role_name: newRole,
        scope_type: newRole === 'super_admin' ? 'platform' : 'district',
        scope_value: newRole === 'super_admin' ? null : newScopeValue || null,
      });
      setReassigningId(null);
      setNewRole('station_officer');
      setNewScopeValue('');
      setConfirmedFor(officerId);
      load();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to reassign posting');
    } finally {
      setSubmitting(false);
    }
  };

  const openResetPassword = (officerId: number) => {
    setResettingId(officerId);
    setResetError(null);
    setResetConfirmedFor(null);
    setNewPassword('');
    setConfirmPassword('');
  };

  const closeResetPassword = () => {
    setResettingId(null);
    setResetError(null);
    setNewPassword('');
    setConfirmPassword('');
  };

  const handleConfirmResetPassword = async (officerId: number) => {
    if (newPassword.length < 8) {
      setResetError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setResetError('Passwords do not match.');
      return;
    }
    setResetSubmitting(true);
    setResetError(null);
    try {
      await adminService.resetOfficerPassword(officerId, newPassword);
      setResettingId(null);
      setNewPassword('');
      setConfirmPassword('');
      setResetConfirmedFor(officerId);
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setResetSubmitting(false);
    }
  };

  return (
    <main className="flex-1 overflow-y-auto min-h-0 w-full">
      <div className="max-w-4xl mx-auto p-4 sm:p-6">
        {canManageUsers && (
        <>
        <div className="flex items-center gap-3 mb-1">
          <span className="inline-flex p-2 bg-command/10 border border-command/30 text-command rounded-lg">
            <Users size={18} />
          </span>
          <div>
            <h1 className="text-sm font-semibold text-white uppercase tracking-wide">Officers &amp; Postings</h1>
            <p className="text-[11px] text-slate-500">Reassign a station&apos;s role and jurisdiction</p>
          </div>
        </div>

        <div className="mt-6">
          {error && (
            <div className="flex items-start gap-2.5 p-3 mb-4 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>
                <p className="text-xs font-semibold">Failed to load officers</p>
                <p className="text-[11px] text-signal-red/80">{error}</p>
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
            <div className="flex flex-col gap-2.5 animate-pulse" aria-label="Loading officers">
              {[1, 2, 3].map((item) => (
                <div key={item} className="border border-line rounded-lg bg-panel p-4 h-[76px] flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-panel-raised shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 bg-panel-raised rounded w-1/3" />
                    <div className="h-2.5 bg-panel-raised rounded w-1/4" />
                  </div>
                  <div className="h-6 w-20 bg-panel-raised rounded-full" />
                </div>
              ))}
            </div>
          ) : !error && officers.length === 0 ? (
            <div className="flex flex-col items-center text-center gap-2 py-16 text-slate-500">
              <Users size={28} className="text-slate-600" />
              <p className="text-xs font-semibold text-slate-400">No officers found</p>
              <p className="text-[11px] text-slate-600">Officers you&apos;re authorized to manage will appear here.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {officers.map((officer) => (
                <div
                  key={officer.id}
                  className="border border-line rounded-lg bg-panel p-4 transition-colors hover:border-slate-600"
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-panel-raised border border-line text-slate-400 shrink-0">
                        <UserCog size={16} />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-white truncate">{officer.name}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[11px] font-mono text-slate-400 tracking-wide">{officer.badge_number}</span>
                          {officer.rank && (
                            <>
                              <span className="text-slate-700">&middot;</span>
                              <span className="text-[11px] text-slate-500">{officer.rank}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      {officer.active_posting ? (
                        <>
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wider ${roleBadgeClass(
                              officer.active_posting.role
                            )}`}
                          >
                            {officer.active_posting.role}
                          </span>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-line bg-panel-raised text-[10px] text-slate-400">
                            <MapPin size={10} />
                            {officer.active_posting.scope_value ?? 'Platform-wide'}
                          </span>
                        </>
                      ) : (
                        <span className="text-[11px] text-slate-600 italic">No active posting</span>
                      )}

                      <button
                        type="button"
                        onClick={() => openReassign(officer.id)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-panel-raised border border-line rounded text-slate-300 hover:text-white hover:border-slate-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                      >
                        <ArrowLeftRight size={12} />
                        Reassign
                      </button>
                      {canResetPasswords && (
                        <button
                          type="button"
                          onClick={() => openResetPassword(officer.id)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-panel-raised border border-line rounded text-slate-300 hover:text-white hover:border-slate-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                        >
                          <KeyRound size={12} />
                          Reset Password
                        </button>
                      )}
                    </div>
                  </div>

                  {confirmedFor === officer.id && (
                    <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-md border border-signal-green/30 bg-signal-green/10 text-signal-green text-[11px]">
                      <CheckCircle2 size={14} />
                      Posting reassigned successfully.
                    </div>
                  )}

                  {resetConfirmedFor === officer.id && (
                    <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-md border border-signal-green/30 bg-signal-green/10 text-signal-green text-[11px]">
                      <CheckCircle2 size={14} />
                      Password reset. Share the new password with the officer through a secure channel.
                    </div>
                  )}

                  {resettingId === officer.id && (
                    <div className="mt-4 pt-4 border-t border-line">
                      <div className="rounded-md border border-line bg-panel-raised/60 p-3.5">
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-[10px] font-semibold tracking-wider uppercase text-slate-400">
                            Reset Password
                          </p>
                          <button
                            type="button"
                            onClick={closeResetPassword}
                            aria-label="Cancel password reset"
                            className="text-slate-500 hover:text-white p-1 -m-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                          >
                            <X size={14} />
                          </button>
                        </div>

                        <div className="flex flex-col sm:flex-row gap-3">
                          <div className="flex-1">
                            <label
                              htmlFor={`new-password-${officer.id}`}
                              className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1"
                            >
                              New Password
                            </label>
                            <input
                              id={`new-password-${officer.id}`}
                              type="password"
                              value={newPassword}
                              onChange={(e) => setNewPassword(e.target.value)}
                              placeholder="At least 8 characters"
                              className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                            />
                          </div>
                          <div className="flex-1">
                            <label
                              htmlFor={`confirm-password-${officer.id}`}
                              className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1"
                            >
                              Confirm Password
                            </label>
                            <input
                              id={`confirm-password-${officer.id}`}
                              type="password"
                              value={confirmPassword}
                              onChange={(e) => setConfirmPassword(e.target.value)}
                              placeholder="Re-type the new password"
                              className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                            />
                          </div>
                        </div>

                        {resetError && (
                          <p className="mt-3 text-[11px] text-signal-red flex items-center gap-1.5">
                            <AlertTriangle size={12} className="shrink-0" />
                            {resetError}
                          </p>
                        )}

                        <div className="flex items-center gap-2 mt-3.5">
                          <button
                            type="button"
                            disabled={resetSubmitting}
                            onClick={() => handleConfirmResetPassword(officer.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                          >
                            {resetSubmitting && <Loader2 size={12} className="animate-spin" />}
                            Confirm Reset
                          </button>
                          <button
                            type="button"
                            disabled={resetSubmitting}
                            onClick={closeResetPassword}
                            className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white rounded-md transition disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {reassigningId === officer.id && (
                    <div className="mt-4 pt-4 border-t border-line">
                      <div className="rounded-md border border-line bg-panel-raised/60 p-3.5">
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-[10px] font-semibold tracking-wider uppercase text-slate-400">
                            New Posting
                          </p>
                          <button
                            type="button"
                            onClick={closeReassign}
                            aria-label="Cancel reassignment"
                            className="text-slate-500 hover:text-white p-1 -m-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                          >
                            <X size={14} />
                          </button>
                        </div>

                        <div className="flex flex-col sm:flex-row gap-3">
                          <div className="flex-1">
                            <label
                              htmlFor={`role-${officer.id}`}
                              className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1"
                            >
                              New Role
                            </label>
                            <select
                              id={`role-${officer.id}`}
                              value={newRole}
                              onChange={(e) => setNewRole(e.target.value)}
                              className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                            >
                              {ASSIGNABLE_ROLES.map((role) => (
                                <option key={role} value={role}>
                                  {role}
                                </option>
                              ))}
                            </select>
                          </div>

                          {newRole !== 'super_admin' && (
                            <div className="flex-1">
                              <label
                                htmlFor={`scope-${officer.id}`}
                                className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1"
                              >
                                District / Department
                              </label>
                              <input
                                id={`scope-${officer.id}`}
                                value={newScopeValue}
                                onChange={(e) => setNewScopeValue(e.target.value)}
                                placeholder="Traffic Police"
                                className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                              />
                            </div>
                          )}
                        </div>

                        {submitError && (
                          <p className="mt-3 text-[11px] text-signal-red flex items-center gap-1.5">
                            <AlertTriangle size={12} className="shrink-0" />
                            {submitError}
                          </p>
                        )}

                        <div className="flex items-center gap-2 mt-3.5">
                          <button
                            type="button"
                            disabled={submitting}
                            onClick={() => handleConfirmReassignment(officer.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                          >
                            {submitting && <Loader2 size={12} className="animate-spin" />}
                            Confirm Reassignment
                          </button>
                          <button
                            type="button"
                            disabled={submitting}
                            onClick={closeReassign}
                            className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white rounded-md transition disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        </>
        )}

        {permissions.includes('manage_roles') && <RolePermissionsSection />}

        {permissions.includes('manage_circles') && (
          <CircleManagementSection districtScope={role === 'district_command' ? scopeValue : null} />
        )}

        {permissions.includes('view_audit_logs') && <AuditLogSection />}
      </div>
    </main>
  );
}
