'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Users, ShieldCheck, Map as MapIcon, KeyRound, ScrollText, LucideIcon } from 'lucide-react';
import { adminService } from '@/services/adminService';
import { usePermissions } from '@/hooks/usePermissions';
import { OfficersPostingsSection } from './OfficersPostingsSection';
import { RolePermissionsSection } from './RolePermissionsSection';
import { CircleManagementSection } from './CircleManagementSection';
import { PasswordResetRequestsSection } from './PasswordResetRequestsSection';
import { AuditLogSection } from './AuditLogSection';

interface Tile {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  permission: string;
}

const TILES: Tile[] = [
  { id: 'officers', label: 'Officers & Postings', description: 'Roster, jurisdiction, and credentials', icon: Users, permission: 'manage_users_roles' },
  { id: 'roles', label: 'Role Permissions', description: 'Platform-wide role definitions', icon: ShieldCheck, permission: 'manage_roles' },
  { id: 'circles', label: 'Areas', description: 'Manage Areas within districts', icon: MapIcon, permission: 'manage_circles' },
  { id: 'password-requests', label: 'Password Reset Requests', description: 'Review and action officer requests', icon: KeyRound, permission: 'reset_officer_passwords' },
  { id: 'audit-log', label: 'Audit Log', description: 'Every sensitive action, who and where', icon: ScrollText, permission: 'view_audit_logs' },
];

/** Admin console -- a tile per concern (officers, roles, areas, password
 * requests, audit log), one shown at a time. Previously every section was
 * stacked on one page regardless of which the admin actually came here for;
 * this tile switcher is the whole fix for that. Nav, auth, and the global
 * header live in the shared AppShell; the backend is the actual authority
 * on every permission boundary here -- this UI's job is to make the common
 * case pleasant, not to be the security boundary itself. */
export default function AdminPage() {
  const { permissions, role, scopeValue, loading: permissionsLoading } = usePermissions();
  const [pendingRequestCount, setPendingRequestCount] = useState<number | null>(null);

  const visibleTiles = useMemo(
    () => TILES.filter((tile) => permissions.includes(tile.permission)),
    [permissions]
  );
  const [activeTileId, setActiveTileId] = useState<string | null>(null);

  // Land on the first section this admin actually has, once permissions
  // resolve -- avoids a flash of "no sections" before /auth/me returns.
  useEffect(() => {
    if (permissionsLoading || activeTileId !== null || visibleTiles.length === 0) return;
    setActiveTileId(visibleTiles[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionsLoading, visibleTiles]);

  useEffect(() => {
    if (permissionsLoading || !permissions.includes('reset_officer_passwords')) return;
    adminService
      .listPasswordResetRequests('pending')
      .then((rows) => setPendingRequestCount(rows.length))
      .catch(() => {
        // Non-fatal: the tile just shows without a count badge.
      });
  }, [permissionsLoading, permissions]);

  if (!permissionsLoading && visibleTiles.length === 0) {
    return (
      <main className="flex-1 overflow-y-auto min-h-0 w-full flex items-center justify-center">
        <p className="text-sm text-slate-500">You don&apos;t have access to any admin sections.</p>
      </main>
    );
  }

  return (
    <main className="flex-1 overflow-y-auto min-h-0 w-full">
      <div className="max-w-5xl mx-auto p-4 sm:p-6">
        <h1 className="text-sm font-semibold text-white uppercase tracking-wide mb-4">Admin Console</h1>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2.5 mb-6">
          {visibleTiles.map((tile) => {
            const Icon = tile.icon;
            const isActive = activeTileId === tile.id;
            const badgeCount = tile.id === 'password-requests' ? pendingRequestCount : null;
            return (
              <button
                key={tile.id}
                type="button"
                onClick={() => setActiveTileId(tile.id)}
                className={`relative flex flex-col items-center text-center gap-2 p-4 rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command ${
                  isActive
                    ? 'bg-command/10 border-command/40 text-white'
                    : 'bg-panel border-line text-slate-300 hover:border-slate-500 hover:text-white'
                }`}
              >
                {!!badgeCount && (
                  <span className="absolute top-2 right-2 min-w-[18px] h-[18px] px-1 rounded-full bg-signal-red text-white text-[10px] font-bold flex items-center justify-center">
                    {badgeCount}
                  </span>
                )}
                <Icon size={20} className={isActive ? 'text-command' : 'text-slate-400'} />
                <span className="text-xs font-semibold">{tile.label}</span>
                <span className="text-[10px] text-slate-500 leading-tight">{tile.description}</span>
              </button>
            );
          })}
        </div>

        <div className="border-t border-line pt-6">
          {activeTileId === 'officers' && (
            <OfficersPostingsSection canResetPasswords={permissions.includes('reset_officer_passwords')} />
          )}
          {activeTileId === 'roles' && <RolePermissionsSection />}
          {activeTileId === 'circles' && (
            <CircleManagementSection districtScope={role === 'district_command' ? scopeValue : null} />
          )}
          {activeTileId === 'password-requests' && <PasswordResetRequestsSection />}
          {activeTileId === 'audit-log' && <AuditLogSection />}
        </div>
      </div>
    </main>
  );
}
