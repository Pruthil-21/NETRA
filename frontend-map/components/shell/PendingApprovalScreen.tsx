'use client';

import React from 'react';
import { Clock3, LogOut } from 'lucide-react';
import { logout } from '@/lib/session';
import { useRouter } from 'next/navigation';

/** What a freshly self-registered officer sees instead of the normal app
 * shell (spec Section 3.2): "the account is created with zero roles/
 * postings ... the user can log in but sees an empty shell with a
 * 'your account is pending approval' message, nothing else." Their token
 * carries no permissions and no role until a Super Admin/District Command
 * approves the registration and assigns an initial posting. */
export function PendingApprovalScreen() {
  const router = useRouter();

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  return (
    <main className="h-screen w-screen flex items-center justify-center bg-ink p-4">
      <div className="w-full max-w-md bg-panel border border-line rounded-lg p-8 text-center shadow-2xl">
        <div className="inline-flex p-3 bg-signal-amber/10 border border-signal-amber/30 text-signal-amber rounded-lg mb-4">
          <Clock3 size={28} />
        </div>
        <h1 className="text-lg font-bold text-white tracking-wide mb-2">Awaiting Approval</h1>
        <p className="text-xs text-slate-400 leading-relaxed">
          Your registration was received and is pending review by a District Command or Super Admin.
          You&apos;ll be able to access the dashboard once your account is approved and a posting is assigned.
        </p>
        <button
          type="button"
          onClick={handleLogout}
          className="mt-6 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-panel-raised border border-line rounded text-slate-300 hover:text-white hover:border-slate-500 transition-colors"
        >
          <LogOut size={12} />
          Log out
        </button>
      </div>
    </main>
  );
}

export default PendingApprovalScreen;
