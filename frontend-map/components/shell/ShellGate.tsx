'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { useAuthGuard } from '@/lib/useAuthGuard';
import { AppShell } from '@/components/shell/AppShell';

/** The one place that decides "does this route get the nav shell + auth
 * gate" -- /login is the sole exception (nothing to navigate to before
 * signing in, and no session to check yet). Every other route previously
 * duplicated its own auth check inconsistently (or, for /alerts, had none
 * at all) and its own bespoke header. */
export function ShellGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLoginPage = pathname === '/login';
  const authChecked = useAuthGuard(isLoginPage);

  if (isLoginPage) return <>{children}</>;
  if (!authChecked) return null;

  return <AppShell>{children}</AppShell>;
}

export default ShellGate;
