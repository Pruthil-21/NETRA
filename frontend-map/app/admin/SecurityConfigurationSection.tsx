'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Key, Loader2, Lock,
  Plus, Search, ShieldCheck, ShieldOff, Trash2, X,
} from 'lucide-react';
import { adminService, RolePermissionsOut } from '@/services/adminService';
import { roleBadgeClass } from './roleBadge';
import { ALL_PERMISSIONS, PERMISSION_META, permissionLabel } from './permissionMeta';

function SearchBox({
  value, onChange, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative w-full sm:w-64">
      <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-ink border border-line rounded-md pl-8 pr-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
      />
    </div>
  );
}

/** Security Configuration -- one dedicated page for "what can each role do",
 * modeled on D365 F&O's Security configuration screen (Roles / Duties /
 * Privileges tabs), simplified to two tabs since this platform's permission
 * set has no separate Privilege layer: Roles (create, clone, deactivate/
 * delete, and assign or remove permissions) and Permissions (the fixed
 * catalog every role's grant set is built from). Previously this was split
 * across two different, confusingly-overlapping tiles ("Role Permissions"
 * and "Role & Duty Builder") -- this replaces both. */
export function SecurityConfigurationSection() {
  const [tab, setTab] = useState<'roles' | 'permissions'>('roles');
  const [roles, setRoles] = useState<RolePermissionsOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [expandedRoleId, setExpandedRoleId] = useState<number | null>(null);

  const [assigningRole, setAssigningRole] = useState<RolePermissionsOut | null>(null);
  const [newRoleOpen, setNewRoleOpen] = useState(false);
  const [cloningRole, setCloningRole] = useState<RolePermissionsOut | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setLoadError(null);
    adminService
      .getRoles()
      .then(setRoles)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load roles'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const filteredRoles = useMemo(
    () =>
      roles.filter(
        (r) =>
          r.display_name.toLowerCase().includes(search.toLowerCase()) ||
          r.name.toLowerCase().includes(search.toLowerCase())
      ),
    [roles, search]
  );

  const filteredPermissions = useMemo(
    () =>
      ALL_PERMISSIONS.filter((p) => {
        const meta = PERMISSION_META[p];
        const q = search.toLowerCase();
        return p.toLowerCase().includes(q) || meta.label.toLowerCase().includes(q) || meta.module.toLowerCase().includes(q);
      }),
    [search]
  );

  const usageCount = (permission: string) => roles.filter((r) => r.permissions.includes(permission)).length;

  const removePermission = async (role: RolePermissionsOut, permission: string) => {
    setActionError(null);
    try {
      const updated = await adminService.updateRolePermissions(
        role.name,
        role.permissions.filter((p) => p !== permission)
      );
      setRoles((prev) => prev.map((r) => (r.id === role.id ? { ...r, ...updated } : r)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to remove permission');
    }
  };

  const handleClone = async (name: string, displayName: string) => {
    if (!cloningRole) return;
    setActionError(null);
    try {
      await adminService.cloneRole(cloningRole.id, name, displayName);
      setActionMessage(`Cloned "${cloningRole.display_name}" as "${displayName}".`);
      setCloningRole(null);
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to clone role');
    }
  };

  const handleDeactivate = async (role: RolePermissionsOut) => {
    setActionError(null);
    try {
      if (role.is_active) await adminService.deactivateRole(role.id);
      else await adminService.reactivateRole(role.id);
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update role status');
    }
  };

  const handleDelete = async (role: RolePermissionsOut) => {
    setActionError(null);
    try {
      await adminService.deleteRole(role.id);
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete role');
    }
  };

  const handleCreateRole = async (name: string, displayName: string) => {
    setActionError(null);
    try {
      await adminService.createRole({ name, display_name: displayName });
      setNewRoleOpen(false);
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create role');
    }
  };

  return (
    <section>
      <div className="flex items-center gap-3 mb-1">
        <span className="inline-flex p-2 bg-command/10 border border-command/30 text-command rounded-lg">
          <ShieldCheck size={18} />
        </span>
        <div>
          <h1 className="text-sm font-semibold text-white uppercase tracking-wide">Security Configuration</h1>
          <p className="text-[11px] text-slate-500">Roles and the permissions each one grants</p>
        </div>
      </div>

      {/* Action bar */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 mt-4">
        {tab === 'roles' && (
          <button
            type="button"
            onClick={() => setNewRoleOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition self-start"
          >
            <Plus size={12} />
            New Role
          </button>
        )}
        <div className="sm:ml-auto">
          <SearchBox value={search} onChange={setSearch} placeholder={`Search ${tab}…`} />
        </div>
      </div>

      {/* Tab strip */}
      <div className="flex mt-3 border-b border-line">
        {(['roles', 'permissions'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t);
              setSearch('');
            }}
            className={`px-4 py-2.5 text-xs font-semibold uppercase tracking-wide border-b-2 transition-colors ${
              tab === t ? 'text-command border-command' : 'text-slate-500 border-transparent hover:text-slate-300'
            }`}
          >
            {t === 'roles' ? `Roles (${roles.length})` : `Permissions (${ALL_PERMISSIONS.length})`}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {loadError && (
          <div className="flex items-start gap-2.5 p-3 mb-4 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <p className="text-[11px] flex-1">{loadError}</p>
            <button type="button" onClick={load} className="shrink-0 text-[11px] px-2.5 py-1 rounded bg-panel-raised border border-line text-slate-200">
              Retry
            </button>
          </div>
        )}
        {actionError && (
          <div className="flex items-start gap-2.5 p-3 mb-4 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <p className="text-[11px]">{actionError}</p>
          </div>
        )}
        {actionMessage && (
          <div className="flex items-start gap-2.5 p-3 mb-4 rounded-lg border border-signal-green/30 bg-signal-green/10 text-signal-green">
            <Check size={16} className="mt-0.5 shrink-0" />
            <p className="text-[11px]">{actionMessage}</p>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col gap-2.5 animate-pulse" aria-label="Loading">
            {[1, 2, 3].map((i) => (
              <div key={i} className="border border-line rounded-lg bg-panel h-14" />
            ))}
          </div>
        ) : tab === 'roles' ? (
          <div className="border border-line rounded-lg bg-panel overflow-hidden">
            <div className="hidden sm:grid grid-cols-[2fr_1fr_110px_260px] px-4 py-2.5 bg-panel-raised border-b border-line text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
              <span>Role</span>
              <span>Status</span>
              <span className="text-center">Permissions</span>
              <span>Actions</span>
            </div>

            {filteredRoles.length === 0 && (
              <div className="p-9 text-center text-xs text-slate-500">No roles match your search.</div>
            )}

            {filteredRoles.map((role) => (
              <div key={role.id}>
                <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_110px_260px] gap-2 px-4 py-3 border-b border-line last:border-0 items-center">
                  <div className="flex items-center gap-2 min-w-0">
                    <button
                      type="button"
                      onClick={() => setExpandedRoleId(expandedRoleId === role.id ? null : role.id)}
                      aria-label={expandedRoleId === role.id ? `Collapse ${role.display_name}` : `Expand ${role.display_name}`}
                      className="text-command shrink-0"
                    >
                      {expandedRoleId === role.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <Lock size={13} className="text-command shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-white truncate">{role.display_name}</p>
                      <p className="text-[10px] font-mono text-slate-500">{role.name}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    {role.is_system && (
                      <span className="px-1.5 py-0.5 rounded-full border border-line bg-panel-raised text-[9px] text-slate-500 uppercase">System</span>
                    )}
                    <span
                      className={`px-1.5 py-0.5 rounded-full border text-[9px] uppercase ${
                        role.is_active
                          ? 'border-signal-green/30 bg-signal-green/10 text-signal-green'
                          : 'border-signal-amber/30 bg-signal-amber/10 text-signal-amber'
                      }`}
                    >
                      {role.is_active ? 'Active' : 'Deactivated'}
                    </span>
                  </div>

                  <div className="sm:text-center">
                    <span className="inline-flex text-xs font-semibold text-command bg-command/10 px-2.5 py-0.5 rounded-full">
                      {role.permissions.length}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setAssigningRole(role)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium border border-command/40 text-command rounded hover:bg-command/10 transition-colors"
                    >
                      <Plus size={11} />
                      Assign Permissions
                    </button>
                    <button
                      type="button"
                      onClick={() => setCloningRole(role)}
                      title="Clone role"
                      className="p-1.5 rounded border border-line bg-panel-raised text-slate-400 hover:text-white"
                    >
                      <Copy size={12} />
                    </button>
                    {!role.is_system && (
                      <button
                        type="button"
                        onClick={() => handleDeactivate(role)}
                        title={role.is_active ? 'Deactivate role' : 'Reactivate role'}
                        className="p-1.5 rounded border border-line bg-panel-raised text-slate-400 hover:text-signal-amber"
                      >
                        {role.is_active ? <ShieldOff size={12} /> : <ShieldCheck size={12} />}
                      </button>
                    )}
                    {!role.is_system && (
                      <button
                        type="button"
                        onClick={() => handleDelete(role)}
                        title="Delete role (only if unheld)"
                        className="p-1.5 rounded border border-line bg-panel-raised text-slate-400 hover:text-signal-red"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>

                {expandedRoleId === role.id && (
                  <div className="bg-panel-raised/60 border-b border-line px-5 sm:pl-12 py-3.5">
                    <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-2.5">Assigned Permissions</p>
                    {role.permissions.length === 0 ? (
                      <p className="text-xs text-slate-500 italic">No permissions assigned yet. Use &quot;Assign Permissions&quot; to add some.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {role.permissions.map((perm) => (
                          <span
                            key={perm}
                            className="inline-flex items-center gap-1.5 bg-panel border border-line rounded-md pl-2.5 pr-1 py-1 text-[11px] text-slate-200"
                          >
                            {permissionLabel(perm)}
                            <button
                              type="button"
                              onClick={() => removePermission(role, perm)}
                              aria-label={`Remove ${permissionLabel(perm)} from ${role.display_name}`}
                              className="text-slate-500 hover:text-signal-red"
                            >
                              <X size={11} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="border border-line rounded-lg bg-panel overflow-hidden">
            <div className="hidden sm:grid grid-cols-[2fr_120px_2fr_90px] px-4 py-2.5 bg-panel-raised border-b border-line text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
              <span>Permission</span>
              <span>Module</span>
              <span>Description</span>
              <span className="text-center">Used by</span>
            </div>
            {filteredPermissions.map((perm) => (
              <div
                key={perm}
                className="grid grid-cols-1 sm:grid-cols-[2fr_120px_2fr_90px] gap-1.5 px-4 py-3 border-b border-line last:border-0 items-center"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Key size={13} className="text-slate-500 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white truncate">{PERMISSION_META[perm].label}</p>
                    <p className="text-[10px] font-mono text-slate-500">{perm}</p>
                  </div>
                </div>
                <span className="text-[11px] text-slate-400 bg-panel-raised border border-line px-2 py-0.5 rounded self-start sm:self-center inline-block w-fit">
                  {PERMISSION_META[perm].module}
                </span>
                <p className="text-[11px] text-slate-500">{PERMISSION_META[perm].description}</p>
                <span className="sm:text-center text-[11px] text-slate-400">{usageCount(perm)} role(s)</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {assigningRole && (
        <AssignPermissionsModal
          role={assigningRole}
          onClose={() => setAssigningRole(null)}
          onSaved={(updated) => {
            setRoles((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
            setAssigningRole(null);
          }}
        />
      )}
      {newRoleOpen && <RoleFormModal title="Create New Role" confirmLabel="Create Role" onClose={() => setNewRoleOpen(false)} onSave={handleCreateRole} />}
      {cloningRole && (
        <RoleFormModal
          title={`Clone "${cloningRole.display_name}"`}
          confirmLabel="Clone Role"
          onClose={() => setCloningRole(null)}
          onSave={handleClone}
        />
      )}
    </section>
  );
}

function RoleFormModal({
  title, confirmLabel, onClose, onSave,
}: {
  title: string;
  confirmLabel: string;
  onClose: () => void;
  onSave: (name: string, displayName: string) => void;
}) {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [err, setErr] = useState('');

  const submit = () => {
    if (!name.trim() || !displayName.trim()) {
      setErr('Both fields are required.');
      return;
    }
    onSave(name.trim(), displayName.trim());
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[2000] p-4">
      <div className="bg-panel border border-line rounded-lg w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-slate-500 hover:text-white">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4">
          <label htmlFor="role-form-name" className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
            Name (internal id)
          </label>
          <input
            id="role-form-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value.trim().toLowerCase().replace(/\s+/g, '_'));
              setErr('');
            }}
            placeholder="e.g. traffic_ops_lead"
            className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-command mb-3"
          />
          <label htmlFor="role-form-display" className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
            Display Name
          </label>
          <input
            id="role-form-display"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setErr('');
            }}
            placeholder="e.g. Traffic Ops Lead"
            className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
          />
          {err && <p className="mt-2 text-[11px] text-signal-red">{err}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-line">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function AssignPermissionsModal({
  role, onClose, onSaved,
}: {
  role: RolePermissionsOut;
  onClose: () => void;
  onSaved: (updated: RolePermissionsOut) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(role.permissions));
  const [search, setSearch] = useState('');
  const [moduleFilter, setModuleFilter] = useState('All');
  const [reasonCode, setReasonCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modules = ['All', ...Array.from(new Set(ALL_PERMISSIONS.map((p) => PERMISSION_META[p].module)))];
  const filtered = ALL_PERMISSIONS.filter((p) => {
    const meta = PERMISSION_META[p];
    return (moduleFilter === 'All' || meta.module === moduleFilter) && meta.label.toLowerCase().includes(search.toLowerCase());
  });

  const toggle = (permission: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await adminService.updateRolePermissions(role.name, Array.from(selected), reasonCode || undefined);
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save permissions');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[2000] p-4">
      <div className="bg-panel border border-line rounded-lg w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl">
        <div className="px-5 py-4 border-b border-line">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white">Assign Permissions</h2>
              <p className="text-[11px] text-slate-500 mt-1">
                Role: <span className="text-white font-medium">{role.display_name}</span> &middot; {selected.size} permission
                {selected.size !== 1 ? 's' : ''} selected
              </p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="text-slate-500 hover:text-white">
              <X size={18} />
            </button>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 mt-3.5">
            <SearchBox value={search} onChange={setSearch} placeholder="Search permissions…" />
            <select
              value={moduleFilter}
              onChange={(e) => setModuleFilter(e.target.value)}
              className="bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
            >
              {modules.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filtered.map((perm) => (
            <button
              key={perm}
              type="button"
              onClick={() => toggle(perm)}
              className={`w-full text-left flex items-center gap-3 px-5 py-2.5 border-b border-line last:border-0 transition-colors ${
                selected.has(perm) ? 'bg-command/10' : 'hover:bg-panel-raised'
              }`}
            >
              <span
                className={`w-4 h-4 rounded shrink-0 flex items-center justify-center border ${
                  selected.has(perm) ? 'bg-command border-command' : 'border-line bg-ink'
                }`}
              >
                {selected.has(perm) && <Check size={10} className="text-white" strokeWidth={3} />}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-medium text-white">{PERMISSION_META[perm].label}</span>
                <span className="block text-[11px] text-slate-500">
                  {PERMISSION_META[perm].module} &middot; {PERMISSION_META[perm].description}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="px-5 py-3.5 border-t border-line">
          {error && (
            <p className="text-[11px] text-signal-red mb-2 flex items-center gap-1.5">
              <AlertTriangle size={12} />
              {error}
            </p>
          )}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
            <input
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
              placeholder="Reason code (optional, e.g. SCOPE_REDUCTION)"
              aria-label="Reason code"
              className="flex-1 bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
            />
            <div className="flex items-center gap-2 justify-end">
              <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white">
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={save}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition disabled:opacity-50"
              >
                {saving && <Loader2 size={12} className="animate-spin" />}
                Save Changes
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SecurityConfigurationSection;
