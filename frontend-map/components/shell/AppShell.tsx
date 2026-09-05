'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Shield, LayoutDashboard, Map as MapIcon, Search, ShieldAlert, FileBarChart, Film, LogOut, UserCircle2 } from 'lucide-react';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { AlertsBell } from '@/components/alerts/AlertsBell';
import { ThemeToggle } from '@/components/common/ThemeToggle';
import { logout } from '@/lib/session';
import { usePermissions } from '@/hooks/usePermissions';

// Ordered by how often an officer actually reaches for each one during a
// shift: Dashboard (continuous monitoring, the default landing page) first,
// Map (asset/coverage lookup) second, Search and Alerts (on-demand,
// investigative/reactive) last -- not alphabetical, not build order.
const BASE_NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/map', label: 'Map', icon: MapIcon },
  { href: '/search', label: 'Search', icon: Search },
  { href: '/alerts', label: 'Alerts', icon: ShieldAlert },
  { href: '/archive', label: 'Archive', icon: Film },
  { href: '/reports', label: 'Reports', icon: FileBarChart },
];

// Isolated so the once-a-second tick only re-renders this small readout, not
// the whole app -- a live clock is a control-room staple, but it must not be
// the thing that costs frame budget for every page it sits above.
function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="font-mono text-slate-400 tabular-nums">
      {now.toLocaleTimeString('en-IN', { hour12: false })} IST
    </span>
  );
}

// Fixed to the viewport corner (not inside the scrollable page content) so
// it stays visible on every page regardless of scroll position -- an
// officer glancing at "when did I last log in" shouldn't have to scroll up.
function LastLoginBadge() {
  const { lastLogin, loading } = usePermissions();
  if (loading || !lastLogin) return null;

  return (
    <Link
      href="/profile"
      className="fixed bottom-2 right-3 z-40 px-2 py-1 rounded bg-panel/90 border border-line text-[10px] text-slate-500 hover:text-slate-300 hover:border-command/50 font-mono backdrop-blur-sm transition-colors"
      title="View your profile"
    >
      Last login: {new Date(lastLogin).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}
    </Link>
  );
}

function StatusTicker() {
  const { cameras } = useCameraRegistry();
  const counts = useMemo(() => {
    let online = 0;
    let offline = 0;
    for (const cam of cameras) {
      if ((cam.connectivity_status || 'offline').toLowerCase() === 'online') online++;
      else offline++;
    }
    return { online, offline };
  }, [cameras]);

  return (
    <div className="flex items-center gap-3 font-mono">
      <span className="flex items-center gap-1.5 text-slate-400">
        <span className="w-1.5 h-1.5 rounded-full bg-signal-green" />
        {counts.online} ONLINE
      </span>
      <span className="flex items-center gap-1.5 text-slate-500">
        <span className="w-1.5 h-1.5 rounded-full bg-signal-red" />
        {counts.offline} OFFLINE
      </span>
    </div>
  );
}

/** One persistent top bar for the whole app -- previously each page (map,
 * search, alerts) built its own bespoke header with its own back button and
 * duplicated nav links. Navigation is a tab strip (underline indicator) so
 * it reads visually distinct from the bordered pill buttons pages use for
 * page-specific actions (Add Camera, Add to Blacklist, Refresh) -- two
 * different jobs (wayfinding vs. commands) get two different shapes. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { has } = usePermissions();
  // Every permission gating a section actually rendered on /admin (see that
  // page's own per-section `permissions.includes(...)` checks) -- an Auditor
  // holds only view_audit_logs, never manage_users_roles, so gating the nav
  // link on manage_users_roles alone left them with no way to reach the one
  // section they're actually meant to use.
  const canSeeAdmin =
    has('manage_users_roles') ||
    has('manage_roles') ||
    has('manage_circles') ||
    has('view_audit_logs') ||
    has('reset_officer_passwords');
  const navItems = canSeeAdmin
    ? [...BASE_NAV_ITEMS, { href: '/admin', label: 'Admin', icon: Shield }]
    : BASE_NAV_ITEMS;

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-ink text-slate-100 overflow-hidden">
      <header className="border-b border-line bg-panel shrink-0">
        <div className="h-14 px-3 sm:px-4 flex items-center gap-1 sm:gap-2">
          <Link href="/" className="flex items-center gap-2 pr-2 sm:pr-3 shrink-0" aria-label="NETRA home">
            <Shield className="text-command shrink-0" size={20} />
            <span className="font-bold text-sm tracking-wider uppercase text-white hidden sm:inline">NETRA</span>
          </Link>

          <div className="h-6 w-px bg-line shrink-0" />

          <nav aria-label="Primary" className="flex items-center flex-1 min-w-0 overflow-x-auto">
            {navItems.map((item) => {
              const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? 'page' : undefined}
                  className={`relative flex items-center gap-1.5 px-3 h-14 text-xs font-semibold uppercase tracking-wide whitespace-nowrap border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command focus-visible:ring-inset ${
                    isActive
                      ? 'text-white border-command'
                      : 'text-slate-400 border-transparent hover:text-slate-200 hover:border-line'
                  }`}
                >
                  <Icon size={14} />
                  <span className="hidden md:inline">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-3 text-xs shrink-0 pl-2">
            <LiveClock />
            <div className="hidden lg:block h-4 w-px bg-line" />
            <div className="hidden lg:block">
              <StatusTicker />
            </div>
            <div className="hidden md:block h-4 w-px bg-line" />
            <AlertsBell />
            <ThemeToggle />
            <Link
              href="/profile"
              aria-label="My profile"
              aria-current={pathname === '/profile' ? 'page' : undefined}
              className={`p-1.5 rounded border border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command ${
                pathname === '/profile'
                  ? 'text-command bg-panel-raised border-command/50'
                  : 'text-slate-400 hover:text-white bg-panel-raised'
              }`}
            >
              <UserCircle2 size={14} />
            </Link>
            <button
              type="button"
              onClick={handleLogout}
              aria-label="Log out"
              className="p-1.5 text-slate-400 hover:text-signal-red bg-panel-raised rounded border border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden min-h-0">{children}</div>
      <LastLoginBadge />
    </div>
  );
}

export default AppShell;
