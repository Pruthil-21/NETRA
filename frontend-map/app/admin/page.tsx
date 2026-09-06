'use client';

import { useEffect, useMemo, useState } from 'react';
import { Users, ShieldCheck, Map as MapIcon, KeyRound, ScrollText, UserPlus, Search, LucideIcon } from 'lucide-react';
import { adminService } from '@/services/adminService';
import { usePermissions } from '@/hooks/usePermissions';
import { UsersSection } from './UsersSection';
import { SecurityConfigurationSection } from './SecurityConfigurationSection';
import { CircleManagementSection } from './CircleManagementSection';
import { PasswordResetRequestsSection } from './PasswordResetRequestsSection';
import { AuditLogSection } from './AuditLogSection';
import { ApprovalsSection } from './ApprovalsSection';
import { SecurityDiagnosticsSection } from './SecurityDiagnosticsSection';
import { SodRulesSection } from './SodRulesSection';

interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  permission: string;
  /** Users needs the full width and its own internal scroll panes (a
   * roster + detail split), unlike every other section, which is a normal
   * single-column, page-scrolls form. */
  fullBleed?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'security', label: 'Security Configuration', icon: ShieldCheck, permission: 'manage_roles' },
  { id: 'users', label: 'Users', icon: Users, permission: 'manage_users_roles', fullBleed: true },
  { id: 'approvals', label: 'Pending Approvals', icon: UserPlus, permission: 'manage_users_roles' },
  { id: 'diagnostics', label: 'Security Diagnostics', icon: Search, permission: 'manage_roles' },
  { id: 'sod-rules', label: 'SoD Rules', icon: ShieldCheck, permission: 'manage_roles' },
  { id: 'circles', label: 'Areas', icon: MapIcon, permission: 'manage_circles' },
  { id: 'password-requests', label: 'Password Reset Requests', icon: KeyRound, permission: 'reset_officer_passwords' },
  { id: 'audit-log', label: 'Audit Log', icon: ScrollText, permission: 'view_audit_logs' },
];

/** Admin console -- a left-aligned vertical nav (one section per concern),
 * one section shown at a time in the full remaining width. Previously a
 * horizontal grid of description-heavy tiles ate most of the vertical
 * space before any real content appeared; a slim sidebar (the same pattern
 * AppShell already uses for the top-level app nav) fixes that and scales
 * to more sections without the grid reflowing. "Security Configuration"
 * (roles + the permissions each grants) and "Users" (roster + role
 * assignment) come first since they're what an admin reaches for
 * constantly -- each is its own dedicated, focused page instead of being
 * split across several overlapping ones ("Role Permissions", "Role & Duty
 * Builder", "Officers & Postings") that made it unclear what lived where.
 * Auth and the global header live in the shared AppShell; the backend is
 * the actual authority on every permission boundary here -- this UI's job
 * is to make the common case pleasant, not to be the security boundary
 * itself. */
export default function AdminPage() {
  const { permissions, role, scopeValue, loading: permissionsLoading } = usePermissions();
  const [pendingRequestCount, setPendingRequestCount] = useState<number | null>(null);

  const visibleItems = useMemo(
    () => NAV_ITEMS.filter((item) => permissions.includes(item.permission)),
    [permissions]
  );
  const [activeId, setActiveId] = useState<string | null>(null);

  // Land on the first section this admin actually has, once permissions
  // resolve -- avoids a flash of "no sections" before /auth/me returns.
  useEffect(() => {
    if (permissionsLoading || activeId !== null || visibleItems.length === 0) return;
    setActiveId(visibleItems[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionsLoading, visibleItems]);

  useEffect(() => {
    if (permissionsLoading || !permissions.includes('reset_officer_passwords')) return;
    adminService
      .listPasswordResetRequests('pending')
      .then((rows) => setPendingRequestCount(rows.length))
      .catch(() => {
        // Non-fatal: the nav item just shows without a count badge.
      });
  }, [permissionsLoading, permissions]);

  if (permissionsLoading) {
    return (
      <main className="flex-1 flex overflow-hidden min-h-0 w-full">
        <div className="w-60 shrink-0 border-r border-line bg-panel p-3">
          <div className="flex flex-col gap-1.5 animate-pulse" aria-label="Loading admin console">
            {[1, 2, 3, 4, 5].map((item) => (
              <div key={item} className="h-9 rounded-md bg-panel-raised" />
            ))}
          </div>
        </div>
        <div className="flex-1" />
      </main>
    );
  }

  if (visibleItems.length === 0) {
    return (
      <main className="flex-1 overflow-y-auto min-h-0 w-full flex items-center justify-center">
        <p className="text-sm text-slate-500">You don&apos;t have access to any admin sections.</p>
      </main>
    );
  }

  const activeItem = visibleItems.find((t) => t.id === activeId);

  const activeContent = (
    <>
      {activeId === 'security' && <SecurityConfigurationSection />}
      {activeId === 'users' && <UsersSection canResetPasswords={permissions.includes('reset_officer_passwords')} />}
      {activeId === 'approvals' && <ApprovalsSection />}
      {activeId === 'diagnostics' && <SecurityDiagnosticsSection />}
      {activeId === 'sod-rules' && <SodRulesSection />}
      {activeId === 'circles' && (
        <CircleManagementSection districtScope={role === 'district_command' ? scopeValue : null} />
      )}
      {activeId === 'password-requests' && <PasswordResetRequestsSection />}
      {activeId === 'audit-log' && <AuditLogSection />}
    </>
  );

  return (
    <main className="flex-1 flex overflow-hidden min-h-0 w-full">
      <aside className="w-60 shrink-0 border-r border-line bg-panel flex flex-col overflow-y-auto">
        <div className="px-4 pt-4 pb-3">
          <h1 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Admin Console</h1>
        </div>
        <nav className="flex-1 px-2.5 pb-4 flex flex-col gap-1">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeId === item.id;
            const badgeCount = item.id === 'password-requests' ? pendingRequestCount : null;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveId(item.id)}
                className={`relative flex items-center gap-2.5 px-3 py-2.5 rounded-md text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command ${
                  isActive
                    ? 'bg-command/10 text-white border-l-2 border-command'
                    : 'text-slate-400 border-l-2 border-transparent hover:text-slate-200 hover:bg-panel-raised'
                }`}
              >
                <Icon size={15} className={isActive ? 'text-command shrink-0' : 'text-slate-500 shrink-0'} />
                <span className="flex-1 truncate">{item.label}</span>
                {!!badgeCount && (
                  <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-signal-red text-white text-[10px] font-bold flex items-center justify-center">
                    {badgeCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="flex-1 min-h-0 overflow-hidden">
        {activeItem?.fullBleed ? (
          <div className="h-full">{activeContent}</div>
        ) : (
          <div className="h-full overflow-y-auto">
            <div className="max-w-5xl p-5 sm:p-7">{activeContent}</div>
          </div>
        )}
      </div>
    </main>
  );
}
