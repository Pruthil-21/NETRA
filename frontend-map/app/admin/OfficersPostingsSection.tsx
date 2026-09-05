'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, CheckCircle2, KeyRound, Loader2, MapPin, Users, UserCog, X } from 'lucide-react';
import { adminService, OfficerOut } from '@/services/adminService';
import { roleBadgeClass } from './roleBadge';

const ASSIGNABLE_ROLES = ['district_command', 'station_officer', 'control_room_operator', 'auditor'];

/** Officer roster: posting reassignment, and (Super Admin only) direct
 * password reset. The backend is the actual authority on every boundary
 * here (delegated admin, reset_officer_passwords) -- this UI's job is to
 * make the common case pleasant, not to be the security boundary itself. */
export function OfficersPostingsSection({ canResetPasswords }: { canResetPasswords: boolean }) {
  const [officers, setOfficers] = useState<OfficerOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reassigningId, setReassigningId] = useState<number | null>(null);
  const [newRole, setNewRole] = useState('station_officer');
  const [newScopeValue, setNewScopeValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmedFor, setConfirmedFor] = useState<number | null>(null);

  const [resettingId, setResettingId] = useState<number | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetConfirmedFor, setResetConfirmedFor] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    adminService
      .listOfficers()
      .then(setOfficers)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load officers'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const openReassign = (officerId: number) => {
    setReassigningId(officerId);
    setSubmitError(null);
    setConfirmedFor(null);
  };

  const closeReassign = () => {
    setReassigningId(null);
    setSubmitError(null);
    setNewRole('station_officer');
    setNewScopeValue('');
  };

  const handleConfirmReassignment = async (officerId: number) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await adminService.reassignPosting({
        officer_id: officerId,
        role_name: newRole,
        scope_type: newRole === 'super_admin' ? 'platform' : 'district',
        scope_value: newRole === 'super_admin' ? null : newScopeValue || null,
      });
      setReassigningId(null);
      setNewRole('station_officer');
      setNewScopeValue('');
      setConfirmedFor(officerId);
      load();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to reassign posting');
    } finally {
      setSubmitting(false);
    }
  };

  const openResetPassword = (officerId: number) => {
    setResettingId(officerId);
    setResetError(null);
    setResetConfirmedFor(null);
    setNewPassword('');
    setConfirmPassword('');
  };

  const closeResetPassword = () => {
    setResettingId(null);
    setResetError(null);
    setNewPassword('');
    setConfirmPassword('');
  };

  const handleConfirmResetPassword = async (officerId: number) => {
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
      await adminService.resetOfficerPassword(officerId, newPassword);
      setResettingId(null);
      setNewPassword('');
      setConfirmPassword('');
      setResetConfirmedFor(officerId);
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setResetSubmitting(false);
    }
  };

  return (
    <section>
      <div className="flex items-center gap-3 mb-1">
        <span className="inline-flex p-2 bg-command/10 border border-command/30 text-command rounded-lg">
          <Users size={18} />
        </span>
        <div>
          <h1 className="text-sm font-semibold text-white uppercase tracking-wide">Officers &amp; Postings</h1>
          <p className="text-[11px] text-slate-500">Reassign a station&apos;s role and jurisdiction</p>
        </div>
      </div>

      <div className="mt-6">
        {error && (
          <div className="flex items-start gap-2.5 p-3 mb-4 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-semibold">Failed to load officers</p>
              <p className="text-[11px] text-signal-red/80">{error}</p>
            </div>
            <button
              type="button"
              onClick={load}
              className="ml-auto shrink-0 text-[11px] px-2.5 py-1 rounded bg-panel-raised border border-line text-slate-200 hover:text-white"
            >
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col gap-2.5 animate-pulse" aria-label="Loading officers">
            {[1, 2, 3].map((item) => (
              <div key={item} className="border border-line rounded-lg bg-panel p-4 h-[76px] flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-panel-raised shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 bg-panel-raised rounded w-1/3" />
                  <div className="h-2.5 bg-panel-raised rounded w-1/4" />
                </div>
                <div className="h-6 w-20 bg-panel-raised rounded-full" />
              </div>
            ))}
          </div>
        ) : !error && officers.length === 0 ? (
          <div className="flex flex-col items-center text-center gap-2 py-16 text-slate-500">
            <Users size={28} className="text-slate-600" />
            <p className="text-xs font-semibold text-slate-400">No officers found</p>
            <p className="text-[11px] text-slate-600">Officers you&apos;re authorized to manage will appear here.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {officers.map((officer) => (
              <div
                key={officer.id}
                className="border border-line rounded-lg bg-panel p-4 transition-colors hover:border-slate-600"
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-panel-raised border border-line text-slate-400 shrink-0">
                      <UserCog size={16} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-white truncate">{officer.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[11px] font-mono text-slate-400 tracking-wide">{officer.badge_number}</span>
                        {officer.rank && (
                          <>
                            <span className="text-slate-700">&middot;</span>
                            <span className="text-[11px] text-slate-500">{officer.rank}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    {officer.active_posting ? (
                      <>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wider ${roleBadgeClass(
                            officer.active_posting.role
                          )}`}
                        >
                          {officer.active_posting.role}
                        </span>
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-line bg-panel-raised text-[10px] text-slate-400">
                          <MapPin size={10} />
                          {officer.active_posting.scope_value ?? 'Platform-wide'}
                        </span>
                      </>
                    ) : (
                      <span className="text-[11px] text-slate-600 italic">No active posting</span>
                    )}

                    <button
                      type="button"
                      onClick={() => openReassign(officer.id)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-panel-raised border border-line rounded text-slate-300 hover:text-white hover:border-slate-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                    >
                      <ArrowLeftRight size={12} />
                      Reassign
                    </button>
                    {canResetPasswords && (
                      <button
                        type="button"
                        onClick={() => openResetPassword(officer.id)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-panel-raised border border-line rounded text-slate-300 hover:text-white hover:border-slate-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                      >
                        <KeyRound size={12} />
                        Reset Password
                      </button>
                    )}
                  </div>
                </div>

                {confirmedFor === officer.id && (
                  <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-md border border-signal-green/30 bg-signal-green/10 text-signal-green text-[11px]">
                    <CheckCircle2 size={14} />
                    Posting reassigned successfully.
                  </div>
                )}

                {resetConfirmedFor === officer.id && (
                  <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-md border border-signal-green/30 bg-signal-green/10 text-signal-green text-[11px]">
                    <CheckCircle2 size={14} />
                    Password reset. Share the new password with the officer through a secure channel.
                  </div>
                )}

                {resettingId === officer.id && (
                  <div className="mt-4 pt-4 border-t border-line">
                    <div className="rounded-md border border-line bg-panel-raised/60 p-3.5">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-[10px] font-semibold tracking-wider uppercase text-slate-400">
                          Reset Password
                        </p>
                        <button
                          type="button"
                          onClick={closeResetPassword}
                          aria-label="Cancel password reset"
                          className="text-slate-500 hover:text-white p-1 -m-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                        >
                          <X size={14} />
                        </button>
                      </div>

                      <div className="flex flex-col sm:flex-row gap-3">
                        <div className="flex-1">
                          <label
                            htmlFor={`new-password-${officer.id}`}
                            className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1"
                          >
                            New Password
                          </label>
                          <input
                            id={`new-password-${officer.id}`}
                            type="password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            placeholder="At least 8 characters"
                            className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                          />
                        </div>
                        <div className="flex-1">
                          <label
                            htmlFor={`confirm-password-${officer.id}`}
                            className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1"
                          >
                            Confirm Password
                          </label>
                          <input
                            id={`confirm-password-${officer.id}`}
                            type="password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder="Re-type the new password"
                            className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                          />
                        </div>
                      </div>

                      {resetError && (
                        <p className="mt-3 text-[11px] text-signal-red flex items-center gap-1.5">
                          <AlertTriangle size={12} className="shrink-0" />
                          {resetError}
                        </p>
                      )}

                      <div className="flex items-center gap-2 mt-3.5">
                        <button
                          type="button"
                          disabled={resetSubmitting}
                          onClick={() => handleConfirmResetPassword(officer.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                        >
                          {resetSubmitting && <Loader2 size={12} className="animate-spin" />}
                          Confirm Reset
                        </button>
                        <button
                          type="button"
                          disabled={resetSubmitting}
                          onClick={closeResetPassword}
                          className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white rounded-md transition disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {reassigningId === officer.id && (
                  <div className="mt-4 pt-4 border-t border-line">
                    <div className="rounded-md border border-line bg-panel-raised/60 p-3.5">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-[10px] font-semibold tracking-wider uppercase text-slate-400">
                          New Posting
                        </p>
                        <button
                          type="button"
                          onClick={closeReassign}
                          aria-label="Cancel reassignment"
                          className="text-slate-500 hover:text-white p-1 -m-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                        >
                          <X size={14} />
                        </button>
                      </div>

                      <div className="flex flex-col sm:flex-row gap-3">
                        <div className="flex-1">
                          <label
                            htmlFor={`role-${officer.id}`}
                            className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1"
                          >
                            New Role
                          </label>
                          <select
                            id={`role-${officer.id}`}
                            value={newRole}
                            onChange={(e) => setNewRole(e.target.value)}
                            className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                          >
                            {ASSIGNABLE_ROLES.map((role) => (
                              <option key={role} value={role}>
                                {role}
                              </option>
                            ))}
                          </select>
                        </div>

                        {newRole !== 'super_admin' && (
                          <div className="flex-1">
                            <label
                              htmlFor={`scope-${officer.id}`}
                              className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1"
                            >
                              District / Department
                            </label>
                            <input
                              id={`scope-${officer.id}`}
                              value={newScopeValue}
                              onChange={(e) => setNewScopeValue(e.target.value)}
                              placeholder="Traffic Police"
                              className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                            />
                          </div>
                        )}
                      </div>

                      {submitError && (
                        <p className="mt-3 text-[11px] text-signal-red flex items-center gap-1.5">
                          <AlertTriangle size={12} className="shrink-0" />
                          {submitError}
                        </p>
                      )}

                      <div className="flex items-center gap-2 mt-3.5">
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={() => handleConfirmReassignment(officer.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                        >
                          {submitting && <Loader2 size={12} className="animate-spin" />}
                          Confirm Reassignment
                        </button>
                        <button
                          type="button"
                          disabled={submitting}
                          onClick={closeReassign}
                          className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white rounded-md transition disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default OfficersPostingsSection;
