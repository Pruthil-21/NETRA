'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Ban, CheckCircle2, KeyRound, Loader2, Lock, LogOut, MapPin,
  Plus, Search, Unlock, Users, X,
} from 'lucide-react';
import { adminService, OfficerOut, OfficerProfileOut } from '@/services/adminService';
import { roleBadgeClass } from './roleBadge';

// super_admin is deliberately last, not filtered out -- the backend
// (main.py's posting-authorization check) already rejects anyone whose own
// role isn't strictly above the one they're trying to grant, so a
// district_command/etc. actor sees this option but gets a 403 attempting to
// use it. Hiding it here as well would just be a second, redundant gate.
const ASSIGNABLE_ROLES = ['district_command', 'station_officer', 'control_room_operator', 'auditor', 'super_admin'];

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

function timeAgo(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** Users: officer roster on the left, detail + actions on the right --
 * replaces the old "Officers & Postings" tile, which mixed the roster,
 * a single-posting reassignment form, and password reset into one flat
 * list. "Assign Roles" is now its own tab and genuinely supports *multiple*
 * simultaneously-held postings (spec Section 3.3), each individually
 * removable, instead of one reassignment form that silently replaced
 * whatever the officer held before. */
export function UsersSection({ canResetPasswords }: { canResetPasswords: boolean }) {
  const [officers, setOfficers] = useState<OfficerOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tab, setTab] = useState<'overview' | 'roles'>('overview');

  const [profile, setProfile] = useState<OfficerProfileOut | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);

  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleMessage, setLifecycleMessage] = useState<string | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  const [resetOpen, setResetOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const [newRole, setNewRole] = useState('station_officer');
  const [newScopeValue, setNewScopeValue] = useState('');
  const [postingSubmitting, setPostingSubmitting] = useState(false);
  const [postingError, setPostingError] = useState<string | null>(null);

  const loadOfficers = () => {
    setLoading(true);
    setLoadError(null);
    adminService
      .listOfficers()
      .then((data) => {
        setOfficers(data);
        setSelectedId((prev) => prev ?? data[0]?.id ?? null);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load officers'))
      .finally(() => setLoading(false));
  };

  useEffect(loadOfficers, []);

  const loadProfile = (officerId: number) => {
    setProfileLoading(true);
    adminService
      .getOfficerProfile(officerId)
      .then(setProfile)
      .catch((err) => setLifecycleError(err instanceof Error ? err.message : 'Failed to load profile'))
      .finally(() => setProfileLoading(false));
  };

  useEffect(() => {
    if (selectedId == null) {
      setProfile(null);
      return;
    }
    setLifecycleMessage(null);
    setLifecycleError(null);
    loadProfile(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const filteredOfficers = useMemo(
    () =>
      officers.filter(
        (o) => o.name.toLowerCase().includes(search.toLowerCase()) || o.badge_number.toLowerCase().includes(search.toLowerCase())
      ),
    [officers, search]
  );

  const selectedOfficer = officers.find((o) => o.id === selectedId) ?? null;

  const refreshAfterChange = () => {
    loadOfficers();
    if (selectedId != null) loadProfile(selectedId);
  };

  const handleSuspend = async () => {
    if (selectedId == null) return;
    setLifecycleBusy(true);
    setLifecycleError(null);
    try {
      await adminService.suspendOfficer(selectedId);
      setLifecycleMessage('Account suspended.');
      refreshAfterChange();
    } catch (err) {
      setLifecycleError(err instanceof Error ? err.message : 'Failed to suspend');
    } finally {
      setLifecycleBusy(false);
    }
  };

  const handleReactivate = async () => {
    if (selectedId == null) return;
    setLifecycleBusy(true);
    setLifecycleError(null);
    try {
      await adminService.reactivateOfficer(selectedId);
      setLifecycleMessage('Account reactivated.');
      refreshAfterChange();
    } catch (err) {
      setLifecycleError(err instanceof Error ? err.message : 'Failed to reactivate');
    } finally {
      setLifecycleBusy(false);
    }
  };

  const handleForceLogout = async () => {
    if (selectedId == null) return;
    setLifecycleBusy(true);
    setLifecycleError(null);
    try {
      await adminService.forceLogoutOfficer(selectedId);
      setLifecycleMessage('Active session(s) revoked.');
    } catch (err) {
      setLifecycleError(err instanceof Error ? err.message : 'Failed to force-logout');
    } finally {
      setLifecycleBusy(false);
    }
  };

  const handleUnlock = async () => {
    if (selectedId == null) return;
    setLifecycleBusy(true);
    setLifecycleError(null);
    try {
      await adminService.unlockOfficer(selectedId);
      setLifecycleMessage('Lockout cleared.');
    } catch (err) {
      setLifecycleError(err instanceof Error ? err.message : 'Failed to unlock');
    } finally {
      setLifecycleBusy(false);
    }
  };

  const handleConfirmResetPassword = async () => {
    if (selectedId == null) return;
    if (newPassword.length < 8) {
      setResetError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setResetError('Passwords do not match.');
      return;
    }
    setResetSubmitting(true);
    setResetError(null);
    try {
      await adminService.resetOfficerPassword(selectedId, newPassword);
      setResetOpen(false);
      setNewPassword('');
      setConfirmPassword('');
      setLifecycleMessage('Password reset. Share the new password with the officer through a secure channel.');
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setResetSubmitting(false);
    }
  };

  const handleAddPosting = async () => {
    if (selectedId == null) return;
    setPostingError(null);
    // Client-side guard mirroring the backend's own check (main.py's
    // _guard_delegated_posting_assignment) -- not a replacement for it, just
    // catches the mistake before a round-trip. This isn't inside a <form>,
    // so an HTML `required` attribute on the input below wouldn't be
    // enforced at all.
    if (newRole !== 'super_admin' && !newScopeValue.trim()) {
      setPostingError('A district-scoped role requires a district');
      return;
    }
    setPostingSubmitting(true);
    try {
      await adminService.reassignPosting({
        officer_id: selectedId,
        role_name: newRole,
        scope_type: newRole === 'super_admin' ? 'platform' : 'district',
        scope_value: newRole === 'super_admin' ? null : newScopeValue || null,
      });
      setNewScopeValue('');
      refreshAfterChange();
    } catch (err) {
      setPostingError(err instanceof Error ? err.message : 'Failed to add posting');
    } finally {
      setPostingSubmitting(false);
    }
  };

  const handleRevokePosting = async (postingId: number) => {
    setPostingError(null);
    try {
      await adminService.revokePosting(postingId);
      refreshAfterChange();
    } catch (err) {
      setPostingError(err instanceof Error ? err.message : 'Failed to revoke posting');
    }
  };

  return (
    <section className="flex flex-col h-full">
      <div className="px-4 sm:px-6 pt-4 pb-3 border-b border-line bg-panel">
        <div className="flex items-center gap-3">
          <span className="inline-flex p-2 bg-command/10 border border-command/30 text-command rounded-lg">
            <Users size={18} />
          </span>
          <div>
            <h1 className="text-sm font-semibold text-white uppercase tracking-wide">Users</h1>
            <p className="text-[11px] text-slate-500">{officers.length} officer(s) &middot; select one to view or manage</p>
          </div>
        </div>
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left: roster */}
        <div className="w-72 sm:w-80 shrink-0 border-r border-line bg-panel flex flex-col min-h-0">
          <div className="p-2.5">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search officers…"
                className="w-full bg-ink border border-line rounded-md pl-8 pr-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loadError && <p className="text-[11px] text-signal-red px-3 py-2">{loadError}</p>}
            {loading ? (
              <div className="p-3 text-[11px] text-slate-500 animate-pulse">Loading officers…</div>
            ) : filteredOfficers.length === 0 ? (
              <div className="p-6 text-center text-[11px] text-slate-500">No officers found.</div>
            ) : (
              filteredOfficers.map((officer) => (
                <button
                  key={officer.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(officer.id);
                    setTab('overview');
                  }}
                  className={`w-full text-left flex items-center gap-2.5 px-3 py-2.5 border-b border-line last:border-0 transition-colors ${
                    selectedId === officer.id ? 'bg-command/10 border-l-2 border-l-command' : 'hover:bg-panel-raised border-l-2 border-l-transparent'
                  }`}
                >
                  <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-panel-raised border border-line text-xs font-semibold text-slate-300 shrink-0">
                    {initialsFor(officer.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold text-white truncate">{officer.name}</span>
                    <span className="block text-[11px] font-mono text-slate-500">{officer.badge_number}</span>
                  </span>
                  <span
                    className="shrink-0 text-[10px] text-slate-400 bg-panel-raised border border-line rounded-full px-1.5 py-0.5"
                    title={`${officer.active_postings?.length ?? 0} role(s) assigned`}
                  >
                    {officer.active_postings?.length ?? 0} role{(officer.active_postings?.length ?? 0) === 1 ? '' : 's'}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right: detail */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {!selectedOfficer ? (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-500">Select a user to view details</div>
          ) : (
            <>
              <div className="px-5 sm:px-6 pt-5 border-b border-line bg-panel">
                {/* Identity row */}
                <div className="flex items-center gap-3.5 flex-wrap">
                  <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-panel-raised border border-line text-base font-semibold text-slate-300 shrink-0">
                    {initialsFor(selectedOfficer.name)}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <h2 className="text-base font-semibold text-white truncate">{selectedOfficer.name}</h2>
                      {profile && (
                        <span
                          className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wider ${
                            profile.status === 'active'
                              ? 'border-signal-green/30 bg-signal-green/10 text-signal-green'
                              : profile.status === 'pending'
                              ? 'border-signal-amber/30 bg-signal-amber/10 text-signal-amber'
                              : 'border-signal-red/30 bg-signal-red/10 text-signal-red'
                          }`}
                        >
                          {profile.status}
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-mono text-slate-500 mt-0.5">
                      {selectedOfficer.badge_number}
                      {selectedOfficer.rank ? ` · ${selectedOfficer.rank}` : ''}
                    </p>
                  </div>
                </div>

                {/* Actions row -- own line, always labeled: an icon-only button
                    row here is exactly what made the old console confusing. */}
                <div className="flex items-center gap-2 flex-wrap mt-4">
                  <button
                    type="button"
                    disabled={lifecycleBusy}
                    onClick={handleSuspend}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-line bg-panel-raised text-slate-300 hover:text-signal-red hover:border-signal-red/40 transition-colors disabled:opacity-50"
                  >
                    <Ban size={13} />
                    Suspend
                  </button>
                  <button
                    type="button"
                    disabled={lifecycleBusy}
                    onClick={handleReactivate}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-line bg-panel-raised text-slate-300 hover:text-signal-green hover:border-signal-green/40 transition-colors disabled:opacity-50"
                  >
                    <CheckCircle2 size={13} />
                    Reactivate
                  </button>
                  <button
                    type="button"
                    disabled={lifecycleBusy}
                    onClick={handleForceLogout}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-line bg-panel-raised text-slate-300 hover:text-white hover:border-slate-500 transition-colors disabled:opacity-50"
                  >
                    <LogOut size={13} />
                    Force Logout
                  </button>
                  <button
                    type="button"
                    disabled={lifecycleBusy}
                    onClick={handleUnlock}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-line bg-panel-raised text-slate-300 hover:text-white hover:border-slate-500 transition-colors disabled:opacity-50"
                  >
                    <Unlock size={13} />
                    Unlock
                  </button>
                  {canResetPasswords && (
                    <button
                      type="button"
                      onClick={() => {
                        setResetOpen(true);
                        setResetError(null);
                        setNewPassword('');
                        setConfirmPassword('');
                      }}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-line bg-panel-raised text-slate-300 hover:text-white hover:border-slate-500 transition-colors"
                    >
                      <KeyRound size={13} />
                      Reset Password
                    </button>
                  )}
                </div>

                <div className="mt-3.5" />

                {lifecycleMessage && (
                  <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-md border border-signal-green/30 bg-signal-green/10 text-signal-green text-[11px]">
                    <CheckCircle2 size={13} />
                    {lifecycleMessage}
                  </div>
                )}
                {lifecycleError && (
                  <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-md border border-signal-red/30 bg-signal-red/10 text-signal-red text-[11px]">
                    <AlertTriangle size={13} />
                    {lifecycleError}
                  </div>
                )}

                <div className="flex">
                  {(['overview', 'roles'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTab(t)}
                      className={`px-4 py-2.5 text-xs font-semibold uppercase tracking-wide border-b-2 transition-colors ${
                        tab === t ? 'text-command border-command' : 'text-slate-500 border-transparent hover:text-slate-300'
                      }`}
                    >
                      {t === 'overview' ? 'Overview' : `Assign Roles (${selectedOfficer.active_postings?.length ?? 0})`}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-6">
                {profileLoading ? (
                  <div className="text-xs text-slate-500 animate-pulse">Loading…</div>
                ) : tab === 'overview' ? (
                  <div className="max-w-xl border border-line rounded-lg bg-panel">
                    <div className="px-5 py-3.5 border-b border-line text-xs font-semibold text-slate-300">Officer Details</div>
                    {[
                      ['Full name', selectedOfficer.name],
                      ['Badge number', selectedOfficer.badge_number],
                      ['Rank', selectedOfficer.rank ?? '—'],
                      ['Status', profile?.status ?? '—'],
                      ['Last login', profile?.last_login_at ? timeAgo(profile.last_login_at) : 'Never'],
                    ].map(([label, value]) => (
                      <div key={label} className="grid grid-cols-[160px_1fr] px-5 py-3 border-b border-line last:border-0 items-center">
                        <span className="text-xs font-semibold text-slate-500">{label}</span>
                        <span className="text-sm text-white">{value}</span>
                      </div>
                    ))}
                    {profile && profile.recent_logins.length > 0 && (
                      <div className="px-5 py-3.5">
                        <p className="text-xs font-semibold text-slate-500 mb-2.5">Recent Logins</p>
                        <div className="flex flex-col gap-1.5">
                          {profile.recent_logins.slice(0, 5).map((login, i) => (
                            <span key={i} className="text-xs text-slate-400">
                              {new Date(login).toLocaleString()}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="max-w-2xl">
                    {postingError && (
                      <p className="text-[11px] text-signal-red mb-3 flex items-center gap-1.5">
                        <AlertTriangle size={12} />
                        {postingError}
                      </p>
                    )}

                    <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-2.5">
                      Assigned Roles ({selectedOfficer.active_postings?.length ?? 0})
                    </p>
                    {(selectedOfficer.active_postings ?? []).length === 0 ? (
                      <div className="border border-dashed border-line rounded-lg p-6 text-center text-xs text-slate-500 mb-6">
                        No roles assigned. Add one below.
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2 mb-6">
                        {selectedOfficer.active_postings.map((posting) => (
                          <div key={posting.id} className="flex items-center gap-3 bg-command/10 border border-command/30 rounded-lg px-3.5 py-2.5">
                            <span className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-command shrink-0">
                              <Lock size={14} className="text-white" />
                            </span>
                            <div className="flex-1 min-w-0">
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wider ${roleBadgeClass(
                                  posting.role
                                )}`}
                              >
                                {posting.role}
                              </span>
                              <span className="inline-flex items-center gap-1 ml-2 text-[11px] text-slate-400">
                                <MapPin size={10} />
                                {posting.scope_value ?? 'Platform-wide'}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleRevokePosting(posting.id)}
                              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium border border-signal-red/40 text-signal-red rounded hover:bg-signal-red/10 transition-colors shrink-0"
                            >
                              <X size={11} />
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-2.5">Add a Role</p>
                    <div className="flex flex-col sm:flex-row gap-2.5">
                      <select
                        value={newRole}
                        onChange={(e) => setNewRole(e.target.value)}
                        aria-label="New role"
                        className="bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
                      >
                        {ASSIGNABLE_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      {newRole !== 'super_admin' && (
                        <input
                          value={newScopeValue}
                          onChange={(e) => setNewScopeValue(e.target.value)}
                          placeholder="District / Department"
                          aria-label="District / Department"
                          className="bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white flex-1 focus:outline-none focus:ring-1 focus:ring-command"
                        />
                      )}
                      <button
                        type="button"
                        disabled={postingSubmitting}
                        onClick={handleAddPosting}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition disabled:opacity-50 shrink-0"
                      >
                        {postingSubmitting ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                        Add
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {resetOpen && selectedOfficer && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[2000] p-4">
          <div className="bg-panel border border-line rounded-lg w-full max-w-sm shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <h2 className="text-sm font-semibold text-white">Reset Password</h2>
              <button type="button" onClick={() => setResetOpen(false)} aria-label="Close" className="text-slate-500 hover:text-white">
                <X size={16} />
              </button>
            </div>
            <div className="px-5 py-4 flex flex-col gap-3">
              <div>
                <label htmlFor="users-new-password" className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
                  New Password
                </label>
                <input
                  id="users-new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
                />
              </div>
              <div>
                <label htmlFor="users-confirm-password" className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
                  Confirm Password
                </label>
                <input
                  id="users-confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
                />
              </div>
              {resetError && <p className="text-[11px] text-signal-red">{resetError}</p>}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-line">
              <button type="button" onClick={() => setResetOpen(false)} className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white">
                Cancel
              </button>
              <button
                type="button"
                disabled={resetSubmitting}
                onClick={handleConfirmResetPassword}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition disabled:opacity-50"
              >
                {resetSubmitting && <Loader2 size={12} className="animate-spin" />}
                Confirm Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default UsersSection;
