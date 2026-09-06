'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Search, XCircle } from 'lucide-react';
import { adminService, DiagnosticsOut, OfficerOut, RolePermissionsOut } from '@/services/adminService';

const VALID_PERMISSIONS = [
  'view_live_feeds', 'search_vehicles', 'edit_watchlist', 'manage_cameras',
  'view_analytics', 'export_data', 'manage_users_roles', 'view_audit_logs',
  'acknowledge_alerts', 'manage_roles', 'manage_stations', 'manage_circles',
  'reset_officer_passwords',
];

/** "Why does/doesn't this user have this access" (spec Section 3.5) --
 * pick an officer or a role directly, plus a permission, and see exactly
 * which role/duty is granting it, or that nothing is. */
export function SecurityDiagnosticsSection() {
  const [mode, setMode] = useState<'officer' | 'role'>('officer');
  const [officers, setOfficers] = useState<OfficerOut[]>([]);
  const [roles, setRoles] = useState<RolePermissionsOut[]>([]);
  const [officerId, setOfficerId] = useState<number | null>(null);
  const [roleId, setRoleId] = useState<number | null>(null);
  const [permission, setPermission] = useState(VALID_PERMISSIONS[0]);
  const [result, setResult] = useState<DiagnosticsOut | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminService.listOfficers().then(setOfficers).catch(() => {});
    adminService.getRoles().then(setRoles).catch(() => {});
  }, []);

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const diag = await adminService.getDiagnostics({
        officerId: mode === 'officer' ? officerId ?? undefined : undefined,
        roleId: mode === 'role' ? roleId ?? undefined : undefined,
        permission,
      });
      setResult(diag);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Diagnostics failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <section>
      <div className="flex items-center gap-3 mb-4">
        <span className="inline-flex p-2 bg-command/10 border border-command/30 text-command rounded-lg">
          <Search size={18} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide">Security Diagnostics</h2>
          <p className="text-[11px] text-slate-500">Why does or doesn&apos;t this user have this access</p>
        </div>
      </div>

      <div className="border border-line rounded-lg bg-panel p-4">
        <div className="flex gap-1.5 mb-3">
          <button
            type="button"
            onClick={() => setMode('officer')}
            className={`px-2.5 py-1.5 rounded-full border text-[11px] font-medium transition-colors ${
              mode === 'officer' ? 'bg-command/10 text-command border-command/30' : 'bg-panel-raised text-slate-400 border-line'
            }`}
          >
            By Officer
          </button>
          <button
            type="button"
            onClick={() => setMode('role')}
            className={`px-2.5 py-1.5 rounded-full border text-[11px] font-medium transition-colors ${
              mode === 'role' ? 'bg-command/10 text-command border-command/30' : 'bg-panel-raised text-slate-400 border-line'
            }`}
          >
            By Role
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          {mode === 'officer' ? (
            <select
              value={officerId ?? ''}
              onChange={(e) => setOfficerId(e.target.value ? Number(e.target.value) : null)}
              className="bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
            >
              <option value="">Select an officer…</option>
              {officers.map((o) => (
                <option key={o.id} value={o.id}>{o.name} ({o.badge_number})</option>
              ))}
            </select>
          ) : (
            <select
              value={roleId ?? ''}
              onChange={(e) => setRoleId(e.target.value ? Number(e.target.value) : null)}
              className="bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
            >
              <option value="">Select a role…</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>{r.display_name}</option>
              ))}
            </select>
          )}
          <select
            value={permission}
            onChange={(e) => setPermission(e.target.value)}
            className="bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
          >
            {VALID_PERMISSIONS.map((perm) => (
              <option key={perm} value={perm}>{perm}</option>
            ))}
          </select>
        </div>

        {error && (
          <p className="text-[11px] text-signal-red mb-2 flex items-center gap-1.5">
            <AlertTriangle size={12} />
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={running || (mode === 'officer' ? officerId == null : roleId == null)}
          onClick={run}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition disabled:opacity-50"
        >
          {running && <Loader2 size={12} className="animate-spin" />}
          Run Diagnostics
        </button>

        {result && (
          <div className="mt-4 pt-4 border-t border-line">
            <div
              className={`flex items-center gap-2 px-3 py-2 rounded-md border text-xs font-semibold mb-3 ${
                result.has_permission
                  ? 'border-signal-green/30 bg-signal-green/10 text-signal-green'
                  : 'border-signal-red/30 bg-signal-red/10 text-signal-red'
              }`}
            >
              {result.has_permission ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              {result.has_permission ? 'Has this permission' : 'Does not have this permission'}
            </div>
            {result.granting_roles.length > 0 && (
              <p className="text-[11px] text-slate-400 mb-1">
                Directly via role(s): <span className="text-white font-mono">{result.granting_roles.join(', ')}</span>
              </p>
            )}
            {Object.entries(result.granting_duties).map(([role, dutyList]) => (
              <p key={role} className="text-[11px] text-slate-400">
                Via role <span className="text-white font-mono">{role}</span>&apos;s duty(ies):{' '}
                <span className="text-white font-mono">{dutyList.join(', ')}</span>
              </p>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default SecurityDiagnosticsSection;
