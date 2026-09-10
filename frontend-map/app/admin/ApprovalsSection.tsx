'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, UserPlus, X, XCircle } from 'lucide-react';
import { adminService, RegistrationRequestOut } from '@/services/adminService';

const ASSIGNABLE_ROLES = ['district_command', 'station_officer', 'control_room_operator', 'auditor'];

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

/** Pending-approvals queue for self-registered officers (spec Section
 * 3.2) -- approving is really just "assign this person's first posting"
 * in the same action, which is why this form asks for a role + scope
 * exactly like OfficersPostingsSection's reassignment form does. */
export function ApprovalsSection() {
  const [statusFilter, setStatusFilter] = useState('pending');
  const [requests, setRequests] = useState<RegistrationRequestOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [role, setRole] = useState('station_officer');
  const [scopeValue, setScopeValue] = useState('');
  const [approveSubmitting, setApproveSubmitting] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectSubmitting, setRejectSubmitting] = useState(false);
  const [rejectError, setRejectError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setLoadError(null);
    adminService
      .listApprovals(statusFilter || undefined)
      .then(setRequests)
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load approvals'))
      .finally(() => setLoading(false));
  };

  useEffect(load, [statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const openApprove = (requestId: number) => {
    setApprovingId(requestId);
    setApproveError(null);
    setRole('station_officer');
    setScopeValue('');
  };
  const closeApprove = () => setApprovingId(null);

  const confirmApprove = async (request: RegistrationRequestOut) => {
    setApproveError(null);
    // Mirrors the backend's own check (main.py's
    // _guard_delegated_posting_assignment) -- a district-scoped role
    // approved with this left blank used to succeed silently and leave the
    // officer able to see no cameras/data at all.
    if (role !== 'super_admin' && !scopeValue.trim()) {
      setApproveError('A district-scoped role requires a district');
      return;
    }
    setApproveSubmitting(true);
    try {
      await adminService.approveRegistration(
        request.id, role, role === 'super_admin' ? 'platform' : 'district',
        role === 'super_admin' ? null : scopeValue || null
      );
      setApprovingId(null);
      load();
    } catch (err) {
      setApproveError(err instanceof Error ? err.message : 'Failed to approve registration');
    } finally {
      setApproveSubmitting(false);
    }
  };

  const openReject = (requestId: number) => {
    setRejectingId(requestId);
    setRejectError(null);
    setRejectReason('');
  };
  const closeReject = () => setRejectingId(null);

  const confirmReject = async (request: RegistrationRequestOut) => {
    setRejectSubmitting(true);
    setRejectError(null);
    try {
      await adminService.rejectRegistration(request.id, rejectReason || undefined);
      setRejectingId(null);
      load();
    } catch (err) {
      setRejectError(err instanceof Error ? err.message : 'Failed to reject registration');
    } finally {
      setRejectSubmitting(false);
    }
  };

  return (
    <section>
      <div className="flex items-center gap-3 mb-1">
        <span className="inline-flex p-2 bg-command/10 border border-command/30 text-command rounded-lg">
          <UserPlus size={18} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide">Pending Approvals</h2>
          <p className="text-[11px] text-slate-500">Self-registered officers awaiting a posting</p>
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
            <p className="text-[11px]">{loadError}</p>
            <button type="button" onClick={load} className="ml-auto shrink-0 text-[11px] px-2.5 py-1 rounded bg-panel-raised border border-line text-slate-200">
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col gap-2.5 animate-pulse" aria-label="Loading approvals">
            {[1, 2].map((item) => (
              <div key={item} className="border border-line rounded-lg bg-panel p-4 h-[76px]" />
            ))}
          </div>
        ) : !loadError && requests.length === 0 ? (
          <div className="flex flex-col items-center text-center gap-2 py-16 text-slate-500">
            <UserPlus size={28} className="text-slate-600" />
            <p className="text-xs font-semibold text-slate-400">No {statusFilter || ''} approvals</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {requests.map((request) => (
              <div key={request.id} className="border border-line rounded-lg bg-panel p-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-white">{request.name}</p>
                      <span className="text-[11px] font-mono text-slate-400">{request.badge_number}</span>
                      {request.rank && <span className="text-[11px] text-slate-500">{request.rank}</span>}
                    </div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap text-[11px] text-slate-500">
                      {request.department && <span>{request.department}</span>}
                      {request.contact_info && <span>&middot; {request.contact_info}</span>}
                      <span className="text-slate-600">{timeAgo(request.created_at)}</span>
                    </div>
                  </div>

                  {request.status === 'pending' ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => openApprove(request.id)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-signal-green/10 border border-signal-green/30 rounded text-signal-green hover:bg-signal-green/20 transition-colors"
                      >
                        <CheckCircle2 size={12} />
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => openReject(request.id)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-signal-red/10 border border-signal-red/30 rounded text-signal-red hover:bg-signal-red/20 transition-colors"
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

                {request.status === 'rejected' && request.rejection_reason && (
                  <p className="text-[11px] text-slate-500 mt-2 italic">&quot;{request.rejection_reason}&quot;</p>
                )}

                {approvingId === request.id && (
                  <div className="mt-4 pt-4 border-t border-line">
                    <div className="rounded-md border border-line bg-panel-raised/60 p-3.5">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-[10px] font-semibold tracking-wider uppercase text-slate-400">Assign Initial Posting</p>
                        <button type="button" onClick={closeApprove} aria-label="Cancel approval" className="text-slate-500 hover:text-white p-1 -m-1 rounded">
                          <X size={14} />
                        </button>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-3">
                        <div className="flex-1">
                          <label htmlFor={`approve-role-${request.id}`} className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
                            Role
                          </label>
                          <select
                            id={`approve-role-${request.id}`}
                            value={role}
                            onChange={(e) => setRole(e.target.value)}
                            className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                          >
                            {ASSIGNABLE_ROLES.map((r) => (
                              <option key={r} value={r}>{r}</option>
                            ))}
                          </select>
                        </div>
                        {role !== 'super_admin' && (
                          <div className="flex-1">
                            <label htmlFor={`approve-scope-${request.id}`} className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
                              District / Department
                            </label>
                            <input
                              id={`approve-scope-${request.id}`}
                              value={scopeValue}
                              onChange={(e) => setScopeValue(e.target.value)}
                              placeholder="Ahmedabad"
                              className="w-full bg-ink border border-line rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
                            />
                          </div>
                        )}
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
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition disabled:opacity-50"
                        >
                          {approveSubmitting && <Loader2 size={12} className="animate-spin" />}
                          Confirm Approval
                        </button>
                        <button type="button" disabled={approveSubmitting} onClick={closeApprove} className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white rounded-md transition disabled:opacity-50">
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
                        <p className="text-[10px] font-semibold tracking-wider uppercase text-slate-400">Reject Registration</p>
                        <button type="button" onClick={closeReject} aria-label="Cancel rejection" className="text-slate-500 hover:text-white p-1 -m-1 rounded">
                          <X size={14} />
                        </button>
                      </div>
                      <label htmlFor={`reject-reason-${request.id}`} className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
                        Reason (optional)
                      </label>
                      <input
                        id={`reject-reason-${request.id}`}
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="Badge could not be verified"
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
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-signal-red/80 hover:bg-signal-red text-white rounded-md uppercase tracking-wide transition disabled:opacity-50"
                        >
                          {rejectSubmitting && <Loader2 size={12} className="animate-spin" />}
                          Confirm Rejection
                        </button>
                        <button type="button" disabled={rejectSubmitting} onClick={closeReject} className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white rounded-md transition disabled:opacity-50">
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

export default ApprovalsSection;
