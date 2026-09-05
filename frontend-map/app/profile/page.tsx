'use client';

import React, { useState } from 'react';
import { UserCircle2, ShieldCheck, MapPin, Clock, KeyRound, Image as ImageIcon, CheckCircle2, AlertTriangle } from 'lucide-react';
import { usePermissions } from '@/hooks/usePermissions';
import { changePassword, updateProfilePhoto } from '@/services/profileService';

function formatRole(role: string | null): string {
  if (!role) return '—';
  return role
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatLastLogin(lastLogin: string | null): string {
  if (!lastLogin) return 'No prior login on record';
  return new Date(lastLogin).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** Field label + value pair, the read-only building block for every profile
 * detail on this page except the photo and the password form. */
function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-0.5">{label}</p>
      <p className="text-sm text-slate-200">{value}</p>
    </div>
  );
}

function ProfilePhotoSection() {
  const { photoUrl, refetch } = usePermissions();
  const [draftUrl, setDraftUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEditing = () => {
    setDraftUrl(photoUrl ?? '');
    setError(null);
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateProfilePhoto(draftUrl.trim() || null);
      refetch();
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update photo');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <div className="w-20 h-20 rounded-full bg-panel-raised border border-line flex items-center justify-center overflow-hidden shrink-0">
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- an arbitrary
          // officer-supplied URL, not a locally-known asset next/image can optimize.
          <img src={photoUrl} alt="Profile" className="w-full h-full object-cover" />
        ) : (
          <UserCircle2 size={40} className="text-slate-600" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        {editing ? (
          <div className="flex flex-col gap-2">
            <input
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              placeholder="https://... (leave blank to remove)"
              aria-label="Profile photo URL"
              className="w-full bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-command"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="px-3 py-1.5 text-xs font-semibold bg-panel-raised border border-line text-slate-300 rounded"
              >
                Cancel
              </button>
            </div>
            {error && (
              <p className="flex items-center gap-1.5 text-[11px] text-signal-red">
                <AlertTriangle size={12} /> {error}
              </p>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={startEditing}
            className="inline-flex items-center gap-1.5 text-xs text-command hover:underline"
          >
            <ImageIcon size={13} />
            {photoUrl ? 'Change photo' : 'Add a photo'}
          </button>
        )}
      </div>
    </div>
  );
}

function ChangePasswordSection() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match');
      return;
    }

    setSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass =
    'w-full bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition';
  const labelClass = 'block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1';

  return (
    <form onSubmit={handleSubmit} className="space-y-3 max-w-sm">
      <div>
        <label className={labelClass} htmlFor="current-password">Current Password</label>
        <input
          id="current-password"
          type="password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="new-password">New Password</label>
        <input
          id="new-password"
          type="password"
          required
          minLength={8}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="confirm-password">Confirm New Password</label>
        <input
          id="confirm-password"
          type="password"
          required
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className={inputClass}
        />
      </div>

      {error && (
        <p className="flex items-center gap-1.5 text-[11px] text-signal-red">
          <AlertTriangle size={12} /> {error}
        </p>
      )}
      {success && (
        <p className="flex items-center gap-1.5 text-[11px] text-signal-green">
          <CheckCircle2 size={12} /> Password updated.
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded disabled:opacity-50"
      >
        <KeyRound size={13} />
        {submitting ? 'Updating…' : 'Change Password'}
      </button>
    </form>
  );
}

export default function ProfilePage() {
  const { badgeNumber, name, role, rank, scopeValue, lastLogin, loading } = usePermissions();

  if (loading) {
    return <main className="flex-1 p-6 text-sm text-slate-500">Loading profile…</main>;
  }

  return (
    <main className="flex-1 overflow-y-auto min-h-0 w-full p-4 sm:p-6">
      <div className="max-w-2xl mx-auto flex flex-col gap-6">
        <div>
          <h1 className="text-lg font-semibold text-white">My Profile</h1>
          <p className="text-xs text-slate-500">Officer details are managed by your department -- only your password and photo are yours to change here.</p>
        </div>

        <section className="bg-panel border border-line rounded-lg p-4 sm:p-5">
          <ProfilePhotoSection />
          <div className="mt-5 grid grid-cols-2 sm:grid-cols-3 gap-4">
            <DetailRow label="Name" value={name ?? '—'} />
            <DetailRow label="Badge Number" value={<span className="font-mono">{badgeNumber ?? '—'}</span>} />
            <DetailRow
              label="Role"
              value={
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck size={13} className="text-command" />
                  {formatRole(role)}
                </span>
              }
            />
            <DetailRow label="Rank" value={rank ?? '—'} />
            <DetailRow
              label="Jurisdiction"
              value={
                <span className="inline-flex items-center gap-1.5">
                  <MapPin size={13} className="text-slate-500" />
                  {scopeValue ?? 'Platform-wide'}
                </span>
              }
            />
            <DetailRow
              label="Last Login"
              value={
                <span className="inline-flex items-center gap-1.5">
                  <Clock size={13} className="text-slate-500" />
                  {formatLastLogin(lastLogin)}
                </span>
              }
            />
          </div>
        </section>

        <section className="bg-panel border border-line rounded-lg p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">Change Password</h2>
          <ChangePasswordSection />
        </section>
      </div>
    </main>
  );
}
