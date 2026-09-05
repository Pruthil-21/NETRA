'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, MapPin, X, XCircle } from 'lucide-react';
import { adminService, PasswordResetRequestOut } from '@/services/adminService';
import { roleBadgeClass } from './roleBadge';

const STATUS_TABS: { value: string; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: '', label: 'All' },
];

function timeAgo(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** A Super Admin's review queue for officers' self-service "I need my
 * password reset" requests. Deliberately shows only the requesting
 * officer's identity (name, badge, rank, posting) and reason -- never a
 * password value in either direction. Approving opens the exact same
 * new-password form the direct reset uses; this just also marks the
 * request resolved in the same call (see PasswordResetBody.request_id). */
export function PasswordResetRequestsSection() {
  const [statusFilter, setStatusFilter] = useState('pending');
  const [requests, setRequests] = useState<PasswordResetRequestOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [approveSubmitting, setApproveSubmitting] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectSubmitting, setRejectSubmitting] = useState(false);
  const [rejectError, setRejectError] = useState<string | null>(null);

  const [actionMessage, setActionMessage] = useState<{ id: number; text: string } | null>(null);

  const load = () => {
    setLoading(true);
    setLoadError(null);
    adminService
      .listPasswordResetRequests(statusFilter || undefined)
      .then(setRequests)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load requests'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const openApprove = (requestId: number) => {
    setApprovingId(requestId);
    setApproveError(null);
    setNewPassword('');
    setConfirmPassword('');
  };

  const closeApprove = () => {
    setApprovingId(null);
    setApproveError(null);
    setNewPassword('');
    setConfirmPassword('');
  };

  const confirmApprove = async (request: PasswordResetRequestOut) => {
    if (newPassword.length < 8) {
      setApproveError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setApproveError('Passwords do not match.');
      return;
    }
    setApproveSubmitting(true);
    setApproveError(null);
    try {
      await adminService.resetOfficerPassword(request.officer_id, newPassword, request.id);
      setApprovingId(null);
      setActionMessage({ id: request.id, text: 'Approved. Share the new password with the officer through a secure channel.' });
      load();
    } catch (err) {
      setApproveError(err instanceof Error ? err.message : 'Failed to approve request');
    } finally {
      setApproveSubmitting(false);
    }
  };

  const openReject = (requestId: number) => {
    setRejectingId(requestId);
    setRejectError(null);
    setRejectReason('');
  };

  const closeReject = () => {
    setRejectingId(null);
    setRejectError(null);
    setRejectReason('');
  };

  const confirmReject = async (request: PasswordResetRequestOut) => {
    setRejectSubmitting(true);
    setRejectError(null);
    try {
      await adminService.rejectPasswordResetRequest(request.id, rejectReason || undefined);
      setRejectingId(null);
      setActionMessage({ id: request.id, text: 'Request rejected.' });
      load();
    } catch (err) {
      setRejectError(err instanceof Error ? err.message : 'Failed to reject request');
    } finally {
      setRejectSubmitting(false);
    }
  };

  return (
    <section>
      <div className="flex items-center gap-3 mb-1">
        <span className="inline-flex p-2 bg-signal-amber/10 border border-signal-amber/30 text-signal-amber rounded-lg">
          <KeyRound size={18} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide">Password Reset Requests</h2>
          <p className="text-[11px] text-slate-500">Officers requesting a Super Admin reset their password</p>
        </div>
      </div>

      <div className="mt-4 flex gap-1.5">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setStatusFilter(tab.value)}
            className={`px-2.5 py-1.5 rounded-full border text-[11px] font-medium transition-colors ${
              statusFilter === tab.value
                ? 'bg-command/10 text-command border-command/30'
                : 'bg-panel-raised text-slate-400 border-line hover:text-white hover:border-slate-500'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {loadError && (
          <div className="flex items-start gap-2.5 p-3 mb-4 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-semibold">Failed to load requests</p>
              <p className="text-[11px] text-signal-red/80">{loadError}</p>
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
          <div className="flex flex-col gap-2.5 animate-pulse" aria-label="Loading requests">
            {[1, 2].map((item) => (
              <div key={item} className="border border-line rounded-lg bg-panel p-4 h-[76px]" />
            ))}
          </div>
        ) : !loadError && requests.length === 0 ? (
          <div className="flex flex-col items-center text-center gap-2 py-16 text-slate-500">
            <KeyRound size={28} className="text-slate-600" />
            <p className="text-xs font-semibold text-slate-400">
              No {statusFilter || ''} requests{statusFilter ? '' : ' of any status'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {requests.map((request) => (
              <div key={request.id} className="border border-line rounded-lg bg-panel p-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-white">{request.officer_name}</p>
                      <span className="text-[11px] font-mono text-slate-400">{request.badge_number}</span>
                      {request.rank && <span className="text-[11px] text-slate-500">{request.rank}</span>}
                    </div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      {request.role_name && (
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wider ${roleBadgeClass(
                            request.role_name
                          )}`}
                        >
                          {request.role_name}
                        </span>
                      )}
                      {request.scope_type && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-line bg-panel-raised text-[10px] text-slate-400">
                          <MapPin size={10} />
                          {request.scope_value ?? 'Platform-wide'}
                        </span>
                      )}
                      <span className="text-[11px] text-slate-600">{timeAgo(request.requested_at)}</span>
                    </div>
                    {request.reason && (
                      <p className="text-xs text-slate-400 mt-2 italic">&quot;{request.reason}&quot;</p>
                    )}
                  </div>

                  {request.status === 'pending' ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => openApprove(request.id)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-signal-green/10 border border-signal-green/30 rounded text-signal-green hover:bg-signal-green/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                      >
                        <CheckCircle2 size={12} />
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => openReject(request.id)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-signal-red/10 border border-signal-red/30 rounded text-signal-red hover:bg-signal-red/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                      >
                        <XCircle size={12} />
                        Reject
                      </button>
                    </div>
                  ) : (
                    <span
                      className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wider ${
                        request.status === 'approved'
                          ? 'bg-signal-green/10 text-signal-green border-signal-green/30'
                          : 'bg-signal-red/10 text-signal-red border-signal-red/30'
                      }`}
                    >
                      {request.status}
                    </span>
                  )}
                </div>

                {request.status !== 'pending' && request.reviewed_by && (
                  <p className="text-[11px] text-slate-600 mt-2">
                    Reviewed by {request.reviewed_by}
                    {request.reviewed_at ? ` · ${timeAgo(request.reviewed_at)}` : ''}
                  </p>
                )}

                {actionMessage?.id === request.id && (
                  <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-md border border-signal-green/30 bg-signal-green/10 text-signal-green text-[11px]">
                    <CheckCircle2 size={14} />
                    {actionMessage.text}
                  </div>
                )}

                {approvingId === request.id && (
                  <div className="mt-4 pt-4 border-t border-line">
                    <div className="rounded-md border border-line bg-panel-raised/60 p-3.5">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-[10px] font-semibold tracking-wider uppercase text-slate-400">
                          Set New Password
                        </p>
                        <button
                          type="button"
                          onClick={closeApprove}
                          aria-label="Cancel approval"
                          className="text-slate-500 hover:text-white p-1 -m-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                        >
                          <X size={14} />
                        </button>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-3">
                        <div className="flex-1">
                          <label
                            htmlFor={`approve-new-password-${request.id}`}
                            className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1"
                          >
                            New Password
                          </label>
                          <input
                            id={`approve-new-password-${request.id}`}
                            type="password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            placeholder="At least 8 characters"
                            className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                          />
                        </div>
                        <div className="flex-1">
                          <label
                            htmlFor={`approve-confirm-password-${request.id}`}
                            className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1"
                          >
                            Confirm Password
                          </label>
                          <input
                            id={`approve-confirm-password-${request.id}`}
                            type="password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder="Re-type the new password"
                            className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                          />
                        </div>
                      </div>
                      {approveError && (
                        <p className="mt-3 text-[11px] text-signal-red flex items-center gap-1.5">
                          <AlertTriangle size={12} className="shrink-0" />
                          {approveError}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-3.5">
                        <button
                          type="button"
                          disabled={approveSubmitting}
                          onClick={() => confirmApprove(request)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                        >
                          {approveSubmitting && <Loader2 size={12} className="animate-spin" />}
                          Confirm Approval
                        </button>
                        <button
                          type="button"
                          disabled={approveSubmitting}
                          onClick={closeApprove}
                          className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white rounded-md transition disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {rejectingId === request.id && (
                  <div className="mt-4 pt-4 border-t border-line">
                    <div className="rounded-md border border-line bg-panel-raised/60 p-3.5">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-[10px] font-semibold tracking-wider uppercase text-slate-400">
                          Reject Request
                        </p>
                        <button
                          type="button"
                          onClick={closeReject}
                          aria-label="Cancel rejection"
                          className="text-slate-500 hover:text-white p-1 -m-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                        >
                          <X size={14} />
                        </button>
                      </div>
                      <label
                        htmlFor={`reject-reason-${request.id}`}
                        className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1"
                      >
                        Reason (optional)
                      </label>
                      <input
                        id={`reject-reason-${request.id}`}
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="Could not verify identity"
                        className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                      />
                      {rejectError && (
                        <p className="mt-3 text-[11px] text-signal-red flex items-center gap-1.5">
                          <AlertTriangle size={12} className="shrink-0" />
                          {rejectError}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-3.5">
                        <button
                          type="button"
                          disabled={rejectSubmitting}
                          onClick={() => confirmReject(request)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-signal-red/80 hover:bg-signal-red text-white rounded-md uppercase tracking-wide transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                        >
                          {rejectSubmitting && <Loader2 size={12} className="animate-spin" />}
                          Confirm Rejection
                        </button>
                        <button
                          type="button"
                          disabled={rejectSubmitting}
                          onClick={closeReject}
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

export default PasswordResetRequestsSection;
