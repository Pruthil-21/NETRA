'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, KeyRound, UserCheck } from 'lucide-react';
import { login } from '@/lib/session';

export default function LoginPage() {
  const router = useRouter();
  const [badgeNumber, setBadgeNumber] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(badgeNumber, password);
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-ink flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-panel border border-line rounded-lg p-8 shadow-2xl">
        <div className="text-center mb-8">
          <div className="inline-flex p-3 bg-command/10 border border-command/30 text-command rounded-lg mb-3">
            <Shield size={32} />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-wider">NETRA</h1>
          <p className="text-xs text-slate-500 mt-1">Gujarat Unified Video Integration System</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="officer-id" className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
              Badge Number
            </label>
            <div className="relative">
              <UserCheck size={16} className="absolute left-3 top-2.5 text-slate-500" />
              <input
                id="officer-id"
                type="text"
                value={badgeNumber}
                onChange={(e) => setBadgeNumber(e.target.value)}
                placeholder="GJ-SO-001"
                className="w-full bg-ink border border-line rounded-md pl-10 pr-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                required
              />
            </div>
          </div>
          <div>
            <label htmlFor="passcode" className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
              Passcode
            </label>
            <div className="relative">
              <KeyRound size={16} className="absolute left-3 top-2.5 text-slate-500" />
              <input
                id="passcode"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-ink border border-line rounded-md pl-10 pr-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                required
              />
            </div>
          </div>
          {error && <p className="text-signal-red text-xs">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-command hover:bg-command-dim text-white font-semibold py-2.5 rounded-md text-xs uppercase tracking-wider transition disabled:opacity-50"
          >
            {submitting ? 'Authenticating…' : 'Authenticate Portal'}
          </button>
        </form>

        <p className="text-center text-[10px] text-slate-600 mt-6">
          Authorized personnel only. All access is logged.
        </p>
      </div>
    </main>
  );
}
