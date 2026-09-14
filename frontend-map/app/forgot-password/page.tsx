'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { UserCheck, Mail, KeyRound } from 'lucide-react';
import { requestPasswordResetOtp, resetPasswordWithOtp } from '@/lib/session';
import { PasswordStrengthMeter } from '@/components/common/PasswordStrengthMeter';
import { analyzePassword } from '@/lib/passwordStrength';

/** Self-service reset: request a code, then set a new password with it.
 * Only works for an officer who has set an email (PUT /auth/me/email) --
 * one who hasn't still has the existing admin-mediated
 * password_reset_requests flow (see the profile page), unaffected by this. */
export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<'request' | 'reset'>('request');
  const [badgeNumber, setBadgeNumber] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await requestPasswordResetOtp(badgeNumber);
      setInfo('If that badge number has an email on file, a reset code was sent to it.');
      setStep('reset');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const strength = analyzePassword(newPassword, [badgeNumber]);
    if (!strength.meetsRequirements) {
      setError(`Password is too weak (${strength.strength}). ${strength.weaknesses[0] ?? 'Choose a stronger password.'}`);
      return;
    }
    setSubmitting(true);
    try {
      await resetPasswordWithOtp(badgeNumber, code, newPassword);
      router.push('/login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-ink flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-panel border border-line rounded-lg p-8 shadow-2xl">
        <div className="text-center mb-8">
          <Image src="/logo-mark.png" alt="" width={56} height={56} priority className="mx-auto mb-3" />
          <h1 className="text-2xl font-bold text-white tracking-wider">Reset Password</h1>
          <p className="text-xs text-slate-500 mt-1">Only works if you have an email on file</p>
        </div>

        {step === 'request' ? (
          <form onSubmit={handleRequest} className="space-y-4">
            <div>
              <label htmlFor="badge" className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
                Badge Number
              </label>
              <div className="relative">
                <UserCheck size={16} className="absolute left-3 top-2.5 text-slate-500" />
                <input
                  id="badge"
                  type="text"
                  value={badgeNumber}
                  onChange={(e) => setBadgeNumber(e.target.value)}
                  placeholder="GJ-SO-001"
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
              {submitting ? 'Sending…' : 'Send Reset Code'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleReset} className="space-y-4">
            {info && <p className="text-xs text-emerald-400 text-center">{info}</p>}
            <div>
              <label htmlFor="reset-code" className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
                Verification Code
              </label>
              <div className="relative">
                <Mail size={16} className="absolute left-3 top-2.5 text-slate-500" />
                <input
                  id="reset-code"
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
            <div>
              <label htmlFor="new-password" className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
                New Password
              </label>
              <div className="relative">
                <KeyRound size={16} className="absolute left-3 top-2.5 text-slate-500" />
                <input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={8}
                  className="w-full bg-ink border border-line rounded-md pl-10 pr-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                  required
                />
              </div>
              <PasswordStrengthMeter password={newPassword} userInputs={[badgeNumber]} />
            </div>
            {error && <p className="text-signal-red text-xs">{error}</p>}
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-command hover:bg-command-dim text-white font-semibold py-2.5 rounded-md text-xs uppercase tracking-wider transition disabled:opacity-50"
            >
              {submitting ? 'Resetting…' : 'Reset Password'}
            </button>
            <button
              type="button"
              onClick={() => setStep('request')}
              className="w-full text-[10px] text-slate-500 hover:text-slate-300 transition"
            >
              Didn&apos;t get a code? Request again
            </button>
          </form>
        )}

        <p className="text-center text-[10px] text-slate-600 mt-6">
          <a href="/login" className="text-command hover:underline">
            Back to login
          </a>
        </p>
      </div>
    </main>
  );
}
