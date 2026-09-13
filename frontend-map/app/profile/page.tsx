'use client';

import React, { useEffect, useRef, useState } from 'react';
import { UserCircle2, ShieldCheck, MapPin, Clock, Mail, Phone, Image as ImageIcon, Upload, X, CheckCircle2, AlertTriangle, Bell, BellOff } from 'lucide-react';
import { usePermissions } from '@/hooks/usePermissions';
import { updateProfilePhoto, updateMyEmail, verifyMyEmail } from '@/services/profileService';
import { fileToAvatarDataUri, ImageUploadError } from '@/lib/imageUpload';
import { isPushSupported, isSubscribed, subscribe, unsubscribe } from '@/services/pushSubscriptionService';

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

type PhotoEditMode = 'file' | 'url';

function ProfilePhotoSection() {
  const { photoUrl, refetch } = usePermissions();
  const [mode, setMode] = useState<PhotoEditMode>('file');
  const [draftUrl, setDraftUrl] = useState('');
  // The resized data URI (see lib/imageUpload.ts) ready to save -- distinct
  // from `fileName`, which is just what's shown in the picker UI, so a
  // reader doesn't have to decode the URI to know what file is selected.
  const [draftDataUri, setDraftDataUri] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const startEditing = () => {
    setMode('file');
    setDraftUrl(photoUrl ?? '');
    setDraftDataUri(null);
    setFileName(null);
    setError(null);
    setEditing(true);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // lets picking the exact same file again re-fire onChange
    if (!file) return;
    setError(null);
    try {
      const dataUri = await fileToAvatarDataUri(file);
      setDraftDataUri(dataUri);
      setFileName(file.name);
    } catch (err) {
      setDraftDataUri(null);
      setFileName(null);
      setError(err instanceof ImageUploadError ? err.message : 'Could not process that image.');
    }
  };

  const clearSelectedFile = () => {
    setDraftDataUri(null);
    setFileName(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = mode === 'file' ? draftDataUri : draftUrl.trim() || null;
      await updateProfilePhoto(next);
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
          // officer-supplied URL or locally-resized data URI, not a
          // locally-known asset next/image can optimize.
          <img src={photoUrl} alt="Profile" className="w-full h-full object-cover" />
        ) : (
          <UserCircle2 size={40} className="text-slate-600" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        {editing ? (
          <div className="flex flex-col gap-2 max-w-sm">
            {mode === 'file' ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  aria-label="Upload profile photo"
                  className="hidden"
                />
                {draftDataUri ? (
                  <div className="flex items-center gap-2 bg-ink border border-line rounded px-2.5 py-1.5">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a
                        locally-resized preview of the just-picked file, not
                        a next/image-optimizable asset. */}
                    <img src={draftDataUri} alt="" className="w-6 h-6 rounded-full object-cover shrink-0" />
                    <span className="flex-1 min-w-0 truncate text-xs text-slate-300">{fileName}</span>
                    <button
                      type="button"
                      onClick={clearSelectedFile}
                      aria-label="Remove selected file"
                      className="text-slate-500 hover:text-white p-0.5 shrink-0"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center justify-center gap-1.5 w-full py-3 rounded border border-dashed border-line text-xs text-slate-400 hover:text-white hover:border-command transition"
                  >
                    <Upload size={14} />
                    Add a file
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setMode('url')}
                  className="self-start text-[11px] text-slate-500 hover:text-command"
                >
                  Or paste a URL instead
                </button>
              </>
            ) : (
              <>
                <input
                  value={draftUrl}
                  onChange={(e) => setDraftUrl(e.target.value)}
                  placeholder="https://... (leave blank to remove)"
                  aria-label="Profile photo URL"
                  className="w-full bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-command"
                />
                <button
                  type="button"
                  onClick={() => setMode('file')}
                  className="self-start text-[11px] text-slate-500 hover:text-command"
                >
                  Or upload a file instead
                </button>
              </>
            )}
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

/** Changes the email 2FA codes and self-service password-reset OTPs go to.
 * 2FA itself is mandatory from registration onward (see backend-registry's
 * RegisterRequest.email) -- this only ever changes the address, it can't
 * turn 2FA off. Requires the current password to change, same bar as
 * every other security-relevant profile edit. */
function EmailTwoFactorSection() {
  const { email, refetch } = usePermissions();
  const [draftEmail, setDraftEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Set once PUT /auth/me/email comes back with verification_required --
  // its presence switches the form below from email+password to the code
  // step, same pattern as the login page's OTP step.
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const startEditing = () => {
    setDraftEmail(email ?? '');
    setCurrentPassword('');
    setPendingToken(null);
    setCode('');
    setError(null);
    setSuccess(false);
    setEditing(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!draftEmail.trim()) {
      setError('Email is required -- 2FA cannot be turned off');
      return;
    }
    setSaving(true);
    try {
      const result = await updateMyEmail(draftEmail.trim(), currentPassword);
      if (result.verificationRequired && result.pendingToken) {
        setPendingToken(result.pendingToken);
      } else {
        refetch();
        setEditing(false);
        setSuccess(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update email');
    } finally {
      setSaving(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingToken) return;
    setError(null);
    setSaving(true);
    try {
      await verifyMyEmail(pendingToken, code);
      refetch();
      setEditing(false);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition';
  const labelClass = 'block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1';

  if (!editing) {
    return (
      <div className="space-y-2 max-w-sm">
        <p className="text-xs text-slate-300">
          2FA is <span className="text-signal-green font-semibold">ON</span> -- codes go to{' '}
          {email ? <span className="font-mono">{email}</span> : <span className="text-signal-red">no email on file</span>}
        </p>
        {success && (
          <p className="flex items-center gap-1.5 text-[11px] text-signal-green">
            <CheckCircle2 size={12} /> Email updated.
          </p>
        )}
        <button
          type="button"
          onClick={startEditing}
          className="inline-flex items-center gap-1.5 text-xs text-command hover:underline"
        >
          <Mail size={13} />
          {email ? 'Change email' : 'Add an email'}
        </button>
      </div>
    );
  }

  if (pendingToken) {
    return (
      <form onSubmit={handleVerify} className="space-y-3 max-w-sm">
        <p className="text-xs text-slate-400">
          We emailed a 6-digit code to <span className="font-mono">{draftEmail.trim()}</span>.
        </p>
        <div>
          <label className={labelClass} htmlFor="two-factor-verify-code">Verification Code</label>
          <input
            id="two-factor-verify-code"
            type="text"
            inputMode="numeric"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            maxLength={6}
            className={`${inputClass} tracking-[0.3em] text-center`}
            required
          />
        </div>
        {error && (
          <p className="flex items-center gap-1.5 text-[11px] text-signal-red">
            <AlertTriangle size={12} /> {error}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded disabled:opacity-50"
          >
            <Mail size={13} />
            {saving ? 'Verifying…' : 'Verify & Save'}
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="px-3 py-1.5 text-xs font-semibold bg-panel-raised border border-line text-slate-300 rounded"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 max-w-sm">
      <div>
        <label className={labelClass} htmlFor="two-factor-email">Email</label>
        <input
          id="two-factor-email"
          type="email"
          required
          value={draftEmail}
          onChange={(e) => setDraftEmail(e.target.value)}
          placeholder="you@example.com"
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="two-factor-current-password">Current Password</label>
        <input
          id="two-factor-current-password"
          type="password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className={inputClass}
        />
      </div>
      {error && (
        <p className="flex items-center gap-1.5 text-[11px] text-signal-red">
          <AlertTriangle size={12} /> {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded disabled:opacity-50"
        >
          <Mail size={13} />
          {saving ? 'Sending…' : 'Send Verification Code'}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="px-3 py-1.5 text-xs font-semibold bg-panel-raised border border-line text-slate-300 rounded"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Opt-in toggle for real OS-level push notifications (watchlist match,
 * congestion, camera-down, escalation) -- reaches this device even with
 * the app closed, on top of the in-app bell/poll this app already has.
 * Deliberately opt-in via a toggle here rather than an auto-prompt on
 * every login: an officer grants it once, and it persists as a server-side
 * subscription row, not anything that needs re-asking each session. */
function PushNotificationsSection() {
  const [supported, setSupported] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSupported(isPushSupported());
    isSubscribed()
      .then(setEnabled)
      .catch(() => setEnabled(false))
      .finally(() => setLoading(false));
  }, []);

  const handleToggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (enabled) {
        await unsubscribe();
        setEnabled(false);
      } else {
        await subscribe();
        setEnabled(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update push notification settings');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return null;

  return (
    <section className="bg-panel border border-line rounded-lg p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-white uppercase tracking-wide mb-1">Push Notifications</h2>
      <p className="text-xs text-slate-500 mb-3">
        Get watchlist, congestion, camera-down, and escalation alerts on this device even when
        DIGDHRISHTI isn&apos;t open -- on top of the in-app bell, not instead of it.
      </p>
      {!supported ? (
        <p className="text-xs text-slate-500">Not supported in this browser.</p>
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleToggle}
            disabled={busy}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded disabled:opacity-50 ${
              enabled
                ? 'bg-panel-raised border border-line text-slate-300 hover:text-white'
                : 'bg-command hover:bg-command-dim text-white'
            }`}
          >
            {enabled ? <BellOff size={13} /> : <Bell size={13} />}
            {busy ? 'Updating…' : enabled ? 'Turn Off' : 'Turn On'}
          </button>
          <span className="text-xs text-slate-400">
            {enabled ? (
              <span className="text-signal-green font-semibold">ON</span>
            ) : (
              <span className="text-slate-500">OFF</span>
            )}
          </span>
        </div>
      )}
      {error && (
        <p className="flex items-center gap-1.5 text-[11px] text-signal-red mt-2">
          <AlertTriangle size={12} /> {error}
        </p>
      )}
    </section>
  );
}

export default function ProfilePage() {
  const { badgeNumber, name, role, rank, scopeValue, contactInfo, lastLogin, loading } = usePermissions();

  if (loading) {
    return <main className="flex-1 p-6 text-sm text-slate-500">Loading profile…</main>;
  }

  return (
    <main className="flex-1 overflow-y-auto min-h-0 w-full p-4 sm:p-6">
      <div className="max-w-2xl mx-auto flex flex-col gap-6">
        <div>
          <h1 className="text-lg font-semibold text-white">My Profile</h1>
          <p className="text-xs text-slate-500">
            Officer details are managed by your department -- only your 2FA email and photo are yours to change
            here. Forgot your password? Use &quot;Forgot your password?&quot; on the login page.
          </p>
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
              label="Phone"
              value={
                <span className="inline-flex items-center gap-1.5">
                  <Phone size={13} className="text-slate-500" />
                  {contactInfo ?? '—'}
                </span>
              }
            />
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
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide mb-1">Two-Factor Authentication</h2>
          <p className="text-xs text-slate-500 mb-3">
            Required for every officer. Login sends a 6-digit code to this email, and it&apos;s also where a
            self-service password reset code goes if you forget your password.
          </p>
          <EmailTwoFactorSection />
        </section>

        <PushNotificationsSection />
      </div>
    </main>
  );
}
