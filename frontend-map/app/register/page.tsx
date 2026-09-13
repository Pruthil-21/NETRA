'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, UserPlus, Mail } from 'lucide-react';
import { registerOfficer, verifyRegistrationOtp } from '@/lib/session';
import { locationsService, District } from '@/services/locationsService';
import { PasswordStrengthMeter } from '@/components/common/PasswordStrengthMeter';
import { analyzePassword } from '@/lib/passwordStrength';
import { SearchSelect } from '@/components/common/SearchSelect';

/** Public self-registration. Submitting creates the officer immediately
 * with zero postings, status='pending' -- but there's no admin approval
 * step left to wait through: entering the code just emailed activates the
 * account with a baseline posting (station_officer, scoped to the
 * department given below) and logs the officer straight in. */
export default function RegisterPage() {
  const router = useRouter();
  const [badgeNumber, setBadgeNumber] = useState('');
  const [name, setName] = useState('');
  const [rank, setRank] = useState('');
  const [selectedDistrict, setSelectedDistrict] = useState<District | null>(null);
  const [email, setEmail] = useState('');
  const [contactInfo, setContactInfo] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Set once POST /auth/register returns a pendingToken -- its presence
  // switches the form below from registration details to the OTP step,
  // same pattern as the login page's OTP step.
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [code, setCode] = useState('');

  // Canonical district list -- Department/District used to be free text,
  // which meant a typo here became this officer's actual posting scope
  // (there's no admin approval step left to catch it, see the file-level
  // comment above). A dropdown from the same reference list every other
  // district picker in the app uses makes that structurally impossible.
  const [districts, setDistricts] = useState<District[]>([]);
  useEffect(() => {
    locationsService.listDistricts().then(setDistricts).catch(() => setDistricts([]));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!selectedDistrict) {
      setError('Select a Department/District.');
      return;
    }
    if (!contactInfo.trim()) {
      setError('Phone number is required.');
      return;
    }
    const strength = analyzePassword(password, [badgeNumber, name, email]);
    if (!strength.meetsRequirements) {
      setError(`Password is too weak (${strength.strength}). ${strength.weaknesses[0] ?? 'Choose a stronger password.'}`);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await registerOfficer({
        badgeNumber, name, rank: rank || undefined, department: selectedDistrict.name, email,
        contactInfo, password,
      });
      setPendingToken(result.pendingToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingToken) return;
    setError(null);
    setSubmitting(true);
    try {
      await verifyRegistrationOtp(pendingToken, code);
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (pendingToken) {
    return (
      <main className="min-h-screen bg-ink flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-panel border border-line rounded-lg p-8 shadow-2xl">
          <div className="text-center mb-8">
            <div className="inline-flex p-3 bg-command/10 border border-command/30 text-command rounded-lg mb-3">
              <UserPlus size={32} />
            </div>
            <h1 className="text-2xl font-bold text-white tracking-wider">Verify Your Email</h1>
            <p className="text-xs text-slate-500 mt-1">
              We emailed a 6-digit code to <span className="font-mono">{email}</span>
            </p>
          </div>
          <form onSubmit={handleVerify} className="space-y-4">
            <div>
              <label htmlFor="verify-code" className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
                Verification Code
              </label>
              <div className="relative">
                <Mail size={16} className="absolute left-3 top-2.5 text-slate-500" />
                <input
                  id="verify-code"
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
            {error && <p className="text-signal-red text-xs">{error}</p>}
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-command hover:bg-command-dim text-white font-semibold py-2.5 rounded-md text-xs uppercase tracking-wider transition disabled:opacity-50"
            >
              {submitting ? 'Verifying…' : 'Verify & Activate Account'}
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
              Back to registration
            </button>
          </form>
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
          <h1 className="text-2xl font-bold text-white tracking-wider">DIGDHRISHTI</h1>
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
          <div>
            <label htmlFor="email" className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full bg-ink border border-line rounded-md px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
              required
            />
            <p className="text-[10px] text-slate-600 mt-1">
              We&apos;ll send a code here to verify and activate your account.
            </p>
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
              <SearchSelect<District>
                id="department"
                label="Department / District"
                items={districts}
                getKey={(d) => d.id}
                getLabel={(d) => d.name}
                value={selectedDistrict}
                onChange={setSelectedDistrict}
                placeholder="Select a district…"
                emptyMessage="No matching district."
              />
            </div>
          </div>
          <div>
            <label htmlFor="contact-info" className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
              Phone
            </label>
            <input
              id="contact-info"
              value={contactInfo}
              onChange={(e) => setContactInfo(e.target.value)}
              placeholder="Phone number"
              className="w-full bg-ink border border-line rounded-md px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
              required
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
              <PasswordStrengthMeter password={password} userInputs={[badgeNumber, name, email]} />
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
