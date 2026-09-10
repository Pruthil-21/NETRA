'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { useAuthGuard } from '@/lib/useAuthGuard';
import { AppShell } from '@/components/shell/AppShell';
import { LoadingScreen } from '@/components/common/LoadingScreen';
import { PendingApprovalScreen } from '@/components/shell/PendingApprovalScreen';
import { usePermissions } from '@/hooks/usePermissions';

/** The one place that decides "does this route get the nav shell + auth
 * gate" -- /login is the sole exception (nothing to navigate to before
 * signing in, and no session to check yet). Every other route previously
 * duplicated its own auth check inconsistently (or, for /alerts, had none
 * at all) and its own bespoke header.
 *
 * The auth check itself only resolves inside a useEffect (it needs
 * sessionStorage, unavailable during SSR) -- until then this used to
 * `return null`, a blank/white flash on every first load and hard refresh.
 * Showing LoadingScreen for that gap is what "add a loading page for the
 * time before it renders" means here: it's not disguising slow work, it's
 * covering the one render tick where we genuinely don't know yet whether
 * to show the dashboard or bounce to /login. */
export function ShellGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublicPage = pathname === '/login' || pathname === '/register';
  const authChecked = useAuthGuard(isPublicPage);
  const { status, loading: permissionsLoading } = usePermissions();

  if (isPublicPage) return <>{children}</>;
  if (!authChecked) return <LoadingScreen />;
  if (!permissionsLoading && status === 'pending') return <PendingApprovalScreen />;

  return <AppShell>{children}</AppShell>;
}

export default ShellGate;
