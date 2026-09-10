'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, UserPlus } from 'lucide-react';
import { REGISTRY_API_URL } from '@/config/streams';

/** Public self-registration (v2 spec Section 3.2). Submitting creates the
 * officer immediately with zero roles/postings, status='pending' -- they
 * can log in right after, but PendingApprovalScreen is all they'll see
 * until a District Command/Super Admin approves the request. */
export default function RegisterPage() {
  const router = useRouter();
  const [badgeNumber, setBadgeNumber] = useState('');
  const [name, setName] = useState('');
  const [rank, setRank] = useState('');
  const [department, setDepartment] = useState('');
  const [contactInfo, setContactInfo] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${REGISTRY_API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          badge_number: badgeNumber,
          name,
          rank: rank || null,
          department: department || null,
          contact_info: contactInfo || null,
          password,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || `Registration failed: HTTP ${res.status}`);
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <main className="min-h-screen bg-ink flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-panel border border-line rounded-lg p-8 text-center shadow-2xl">
          <div className="inline-flex p-3 bg-signal-green/10 border border-signal-green/30 text-signal-green rounded-lg mb-3">
            <UserPlus size={28} />
          </div>
          <h1 className="text-lg font-bold text-white mb-2">Registration Submitted</h1>
          <p className="text-xs text-slate-400 leading-relaxed mb-6">
            Your request is now in the Pending Approvals queue. You can log in with your badge number and
            password, but your account will show as pending until a District Command or Super Admin approves it.
          </p>
          <button
            type="button"
            onClick={() => router.push('/login')}
            className="w-full bg-command hover:bg-command-dim text-white font-semibold py-2.5 rounded-md text-xs uppercase tracking-wider transition"
          >
            Go to Login
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-ink flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-panel border border-line rounded-lg p-8 shadow-2xl">
        <div className="text-center mb-8">
          <div className="inline-flex p-3 bg-command/10 border border-command/30 text-command rounded-lg mb-3">
            <Shield size={32} />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-wider">NETRA</h1>
          <p className="text-xs text-slate-500 mt-1">Officer Registration</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5">
          <div>
            <label htmlFor="badge-number" className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
              Badge Number
            </label>
            <input
              id="badge-number"
              value={badgeNumber}
              onChange={(e) => setBadgeNumber(e.target.value)}
              placeholder="GJ-SO-002"
              className="w-full bg-ink border border-line rounded-md px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
              required
            />
          </div>
          <div>
            <label htmlFor="name" className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
              Full Name
            </label>
            <input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-ink border border-line rounded-md px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="rank" className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
                Rank
              </label>
              <input
                id="rank"
                value={rank}
                onChange={(e) => setRank(e.target.value)}
                className="w-full bg-ink border border-line rounded-md px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
              />
            </div>
            <div>
              <label htmlFor="department" className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
                Department
              </label>
              <input
                id="department"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                className="w-full bg-ink border border-line rounded-md px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
              />
            </div>
          </div>
          <div>
            <label htmlFor="contact-info" className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
              Contact Info
            </label>
            <input
              id="contact-info"
              value={contactInfo}
              onChange={(e) => setContactInfo(e.target.value)}
              placeholder="Phone or email"
              className="w-full bg-ink border border-line rounded-md px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="password" className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-ink border border-line rounded-md px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                required
              />
            </div>
            <div>
              <label htmlFor="confirm-password" className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
                Confirm Password
              </label>
              <input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full bg-ink border border-line rounded-md px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
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
            {submitting ? 'Submitting…' : 'Register'}
          </button>
        </form>

        <p className="text-center text-[10px] text-slate-600 mt-6">
          Already have an account?{' '}
          <a href="/login" className="text-command hover:underline">
            Log in
          </a>
        </p>
      </div>
    </main>
  );
}
