'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { KeyRound, UserCheck, Mail } from 'lucide-react';
import { login, verifyLoginOtp } from '@/lib/session';

export default function LoginPage() {
  const router = useRouter();
  const [badgeNumber, setBadgeNumber] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Set once POST /auth/login comes back with otp_required -- its presence
  // is what switches the form below from badge+password to the OTP step.
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [rememberDevice, setRememberDevice] = useState(false);

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await login(badgeNumber, password);
      if (result.otpRequired && result.pendingToken) {
        setPendingToken(result.pendingToken);
      } else {
        router.push('/');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleOtpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingToken) return;
    setError(null);
    setSubmitting(true);
    try {
      await verifyLoginOtp(pendingToken, code, rememberDevice);
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-ink flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-panel border border-line rounded-lg p-8 shadow-2xl">
        <div className="text-center mb-8">
          <Image src="/logo-mark.png" alt="" width={56} height={56} priority className="mx-auto mb-3" />
          <h1 className="text-2xl font-bold text-white tracking-wider">DIGDHRISHTI</h1>
          <p className="text-xs text-slate-500 mt-1">Gujarat Unified Video Integration System</p>
        </div>

        {pendingToken ? (
          <form onSubmit={handleOtpSubmit} className="space-y-4">
            <p className="text-xs text-slate-400 text-center">
              We emailed a 6-digit code to your registered email address.
            </p>
            <div>
              <label htmlFor="otp-code" className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
                Verification Code
              </label>
              <div className="relative">
                <Mail size={16} className="absolute left-3 top-2.5 text-slate-500" />
                <input
                  id="otp-code"
                  type="text"
                  inputMode="numeric"
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  maxLength={6}
                  className="w-full bg-ink border border-line rounded-md pl-10 pr-3 py-2 text-sm tracking-[0.3em] text-white text-center focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                  required
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-[11px] text-slate-400">
              <input
                type="checkbox"
                checked={rememberDevice}
                onChange={(e) => setRememberDevice(e.target.checked)}
                className="accent-command"
              />
              Remember this device for 30 days
            </label>
            {error && <p className="text-signal-red text-xs">{error}</p>}
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-command hover:bg-command-dim text-white font-semibold py-2.5 rounded-md text-xs uppercase tracking-wider transition disabled:opacity-50"
            >
              {submitting ? 'Verifying…' : 'Verify & Continue'}
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingToken(null);
                setCode('');
                setError(null);
              }}
              className="w-full text-[10px] text-slate-500 hover:text-slate-300 transition"
            >
              Back to login
            </button>
          </form>
        ) : (
          <form onSubmit={handleCredentialsSubmit} className="space-y-4">
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
            <p className="text-center text-[10px] text-slate-600">
              <a href="/forgot-password" className="text-command hover:underline">
                Forgot your password?
              </a>
            </p>
          </form>
        )}

        <p className="text-center text-[10px] text-slate-600 mt-6">
          Authorized personnel only. All access is logged.
        </p>
        <p className="text-center text-[10px] text-slate-600 mt-2">
          New officer?{' '}
          <a href="/register" className="text-command hover:underline">
            Register for access
          </a>
        </p>
      </div>
    </main>
  );
}
