'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, Copy, Loader2, PlusCircle, ShieldOff, ShieldCheck, Trash2, GitCompareArrows } from 'lucide-react';
import { adminService, DutyOut, RolePermissionsOut } from '@/services/adminService';

const VALID_PERMISSIONS = [
  'view_live_feeds', 'search_vehicles', 'edit_watchlist', 'manage_cameras',
  'view_analytics', 'export_data', 'manage_users_roles', 'view_audit_logs',
  'acknowledge_alerts', 'manage_roles', 'manage_stations', 'manage_circles',
  'reset_officer_passwords',
];

/** Dynamic role/duty management (v2 spec Section 3.1): Super Admin can
 * create a brand-new role composed of reusable duties, clone an existing
 * one as an independent snapshot, and deactivate (blocks new assignment)
 * or hard-delete (only when nobody currently holds it) a role -- on top of
 * RolePermissionsSection's existing "edit an existing role's permission
 * list" flow, which this doesn't replace. */
export function RoleDutyBuilderSection() {
  const [roles, setRoles] = useState<RolePermissionsOut[]>([]);
  const [duties, setDuties] = useState<DutyOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newDutyName, setNewDutyName] = useState('');
  const [newDutyDisplay, setNewDutyDisplay] = useState('');
  const [newDutyPerms, setNewDutyPerms] = useState<string[]>([]);
  const [dutySubmitting, setDutySubmitting] = useState(false);
  const [dutyError, setDutyError] = useState<string | null>(null);

  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleDisplay, setNewRoleDisplay] = useState('');
  const [newRoleDuties, setNewRoleDuties] = useState<number[]>([]);
  const [roleSubmitting, setRoleSubmitting] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);

  const [cloningId, setCloningId] = useState<number | null>(null);
  const [cloneName, setCloneName] = useState('');
  const [cloneDisplay, setCloneDisplay] = useState('');
  const [cloneError, setCloneError] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setLoadError(null);
    Promise.all([adminService.getRoles(), adminService.listDuties()])
      .then(([r, d]) => {
        setRoles(r);
        setDuties(d);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load roles/duties'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const toggleDutyPerm = (perm: string) => {
    setNewDutyPerms((prev) => (prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]));
  };
  const toggleRoleDuty = (dutyId: number) => {
    setNewRoleDuties((prev) => (prev.includes(dutyId) ? prev.filter((d) => d !== dutyId) : [...prev, dutyId]));
  };

  const submitDuty = async () => {
    setDutySubmitting(true);
    setDutyError(null);
    try {
      await adminService.createDuty(newDutyName, newDutyDisplay, newDutyPerms);
      setNewDutyName('');
      setNewDutyDisplay('');
      setNewDutyPerms([]);
      load();
    } catch (err) {
      setDutyError(err instanceof Error ? err.message : 'Failed to create duty');
    } finally {
      setDutySubmitting(false);
    }
  };

  const submitRole = async () => {
    setRoleSubmitting(true);
    setRoleError(null);
    try {
      await adminService.createRole({ name: newRoleName, display_name: newRoleDisplay, duty_ids: newRoleDuties });
      setNewRoleName('');
      setNewRoleDisplay('');
      setNewRoleDuties([]);
      load();
    } catch (err) {
      setRoleError(err instanceof Error ? err.message : 'Failed to create role');
    } finally {
      setRoleSubmitting(false);
    }
  };

  const submitClone = async (sourceId: number) => {
    setCloneError(null);
    try {
      await adminService.cloneRole(sourceId, cloneName, cloneDisplay);
      setCloningId(null);
      setCloneName('');
      setCloneDisplay('');
      load();
    } catch (err) {
      setCloneError(err instanceof Error ? err.message : 'Failed to clone role');
    }
  };

  const handleDeactivate = async (roleId: number) => {
    setActionError(null);
    try {
      await adminService.deactivateRole(roleId);
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to deactivate role');
    }
  };

  const handleDelete = async (roleId: number) => {
    setActionError(null);
    try {
      await adminService.deleteRole(roleId);
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete role');
    }
  };

  if (loading) {
    return <div className="animate-pulse text-xs text-slate-500">Loading roles &amp; duties…</div>;
  }

  return (
    <section>
      <div className="flex items-center gap-3 mb-4">
        <span className="inline-flex p-2 bg-command/10 border border-command/30 text-command rounded-lg">
          <GitCompareArrows size={18} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide">Role &amp; Duty Builder</h2>
          <p className="text-[11px] text-slate-500">Compose new roles from reusable duties, clone, deactivate, or delete</p>
        </div>
      </div>

      {loadError && (
        <div className="flex items-start gap-2.5 p-3 mb-4 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p className="text-[11px]">{loadError}</p>
        </div>
      )}
      {actionError && (
        <div className="flex items-start gap-2.5 p-3 mb-4 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p className="text-[11px]">{actionError}</p>
        </div>
      )}

      {/* Duty builder */}
      <div className="border border-line rounded-lg bg-panel p-4 mb-6">
        <h3 className="text-xs font-semibold text-white uppercase tracking-wide mb-3">New Duty</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <input
            value={newDutyName}
            onChange={(e) => setNewDutyName(e.target.value)}
            placeholder="name (e.g. watchlist_management)"
            className="bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
          />
          <input
            value={newDutyDisplay}
            onChange={(e) => setNewDutyDisplay(e.target.value)}
            placeholder="Display name"
            className="bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
          />
        </div>
        <div className="flex flex-wrap gap-1.5 mb-3">
          {VALID_PERMISSIONS.map((perm) => (
            <button
              key={perm}
              type="button"
              onClick={() => toggleDutyPerm(perm)}
              className={`px-2 py-1 rounded-full border text-[10px] font-medium transition-colors ${
                newDutyPerms.includes(perm)
                  ? 'bg-command/10 text-command border-command/30'
                  : 'bg-panel-raised text-slate-400 border-line hover:text-white'
              }`}
            >
              {perm}
            </button>
          ))}
        </div>
        {dutyError && <p className="text-[11px] text-signal-red mb-2">{dutyError}</p>}
        <button
          type="button"
          disabled={dutySubmitting || !newDutyName || !newDutyDisplay}
          onClick={submitDuty}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition disabled:opacity-50"
        >
          {dutySubmitting && <Loader2 size={12} className="animate-spin" />}
          <PlusCircle size={12} />
          Create Duty
        </button>

        {duties.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {duties.map((duty) => (
              <span key={duty.id} title={duty.permissions.join(', ')} className="px-2 py-1 rounded-full border border-line bg-panel-raised text-[10px] text-slate-300">
                {duty.display_name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Role builder */}
      <div className="border border-line rounded-lg bg-panel p-4 mb-6">
        <h3 className="text-xs font-semibold text-white uppercase tracking-wide mb-3">New Role</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <input
            value={newRoleName}
            onChange={(e) => setNewRoleName(e.target.value)}
            placeholder="name (e.g. traffic_ops_lead)"
            className="bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
          />
          <input
            value={newRoleDisplay}
            onChange={(e) => setNewRoleDisplay(e.target.value)}
            placeholder="Display name"
            className="bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
          />
        </div>
        {duties.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {duties.map((duty) => (
              <button
                key={duty.id}
                type="button"
                onClick={() => toggleRoleDuty(duty.id)}
                className={`px-2 py-1 rounded-full border text-[10px] font-medium transition-colors ${
                  newRoleDuties.includes(duty.id)
                    ? 'bg-command/10 text-command border-command/30'
                    : 'bg-panel-raised text-slate-400 border-line hover:text-white'
                }`}
              >
                {duty.display_name}
              </button>
            ))}
          </div>
        )}
        {roleError && <p className="text-[11px] text-signal-red mb-2">{roleError}</p>}
        <button
          type="button"
          disabled={roleSubmitting || !newRoleName || !newRoleDisplay}
          onClick={submitRole}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition disabled:opacity-50"
        >
          {roleSubmitting && <Loader2 size={12} className="animate-spin" />}
          <PlusCircle size={12} />
          Create Role
        </button>
      </div>

      {/* Existing roles */}
      <div className="flex flex-col gap-2.5">
        {roles.map((role) => (
          <div key={role.id} className="border border-line rounded-lg bg-panel p-3.5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-white">{role.display_name}</p>
                  <span className="text-[11px] font-mono text-slate-500">{role.name}</span>
                  {role.is_system && (
                    <span className="px-1.5 py-0.5 rounded-full border border-line bg-panel-raised text-[9px] text-slate-500 uppercase">System</span>
                  )}
                  {!role.is_active && (
                    <span className="px-1.5 py-0.5 rounded-full border border-signal-amber/30 bg-signal-amber/10 text-[9px] text-signal-amber uppercase">Deactivated</span>
                  )}
                </div>
                <p className="text-[10px] text-slate-500 mt-1">{role.permissions.length} direct permission(s), {role.duty_ids.length} duty(ies)</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setCloningId(role.id);
                    setCloneName('');
                    setCloneDisplay('');
                    setCloneError(null);
                  }}
                  title="Clone"
                  className="p-1.5 rounded border border-line bg-panel-raised text-slate-400 hover:text-white"
                >
                  <Copy size={12} />
                </button>
                {!role.is_system && role.is_active && (
                  <button type="button" onClick={() => handleDeactivate(role.id)} title="Deactivate" className="p-1.5 rounded border border-line bg-panel-raised text-slate-400 hover:text-signal-amber">
                    <ShieldOff size={12} />
                  </button>
                )}
                {!role.is_system && !role.is_active && (
                  <button type="button" onClick={() => handleDeactivate(role.id)} title="Already deactivated" disabled className="p-1.5 rounded border border-line bg-panel-raised text-slate-600 opacity-50">
                    <ShieldCheck size={12} />
                  </button>
                )}
                {!role.is_system && (
                  <button type="button" onClick={() => handleDelete(role.id)} title="Delete (only if unheld)" className="p-1.5 rounded border border-line bg-panel-raised text-slate-400 hover:text-signal-red">
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>

            {cloningId === role.id && (
              <div className="mt-3 pt-3 border-t border-line flex flex-col sm:flex-row gap-2 items-start sm:items-center">
                <input
                  value={cloneName}
                  onChange={(e) => setCloneName(e.target.value)}
                  placeholder="new name"
                  className="bg-ink border border-line rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
                />
                <input
                  value={cloneDisplay}
                  onChange={(e) => setCloneDisplay(e.target.value)}
                  placeholder="new display name"
                  className="bg-ink border border-line rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
                />
                <button
                  type="button"
                  disabled={!cloneName || !cloneDisplay}
                  onClick={() => submitClone(role.id)}
                  className="px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition disabled:opacity-50"
                >
                  Clone
                </button>
                <button type="button" onClick={() => setCloningId(null)} className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white">
                  Cancel
                </button>
                {cloneError && <p className="text-[11px] text-signal-red">{cloneError}</p>}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export default RoleDutyBuilderSection;
