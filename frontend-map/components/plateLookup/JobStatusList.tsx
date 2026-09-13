'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Ban, CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { anprJobsService, AnprJob } from '@/services/anprJobsService';

const POLL_INTERVAL_MS = 4000;
// Officers submit these far more often than they ever need to look back at
// old ones -- without a cap this list only ever grows, one row per
// submission forever. "Most recent N, expand for the rest" keeps the
// common case (checking on what you just submitted) fast to scan.
const COLLAPSED_COUNT = 8;

function timeAgo(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

function inputTypeLabel(t: AnprJob['input_type']): string {
  if (t === 'upload_video') return 'Video Upload';
  if (t === 'upload_image') return 'Photo Upload';
  return 'Archive Clip';
}

const STATUS_STYLES: Record<AnprJob['status'], { icon: React.ElementType; className: string; label: string }> = {
  pending: { icon: Clock, className: 'text-slate-400', label: 'Pending' },
  processing: { icon: Loader2, className: 'text-command', label: 'Processing' },
  completed: { icon: CheckCircle2, className: 'text-signal-green', label: 'Completed' },
  failed: { icon: XCircle, className: 'text-signal-red', label: 'Failed' },
  cancelled: { icon: Ban, className: 'text-slate-500', label: 'Cancelled' },
};

const CANCELLABLE_STATUSES: AnprJob['status'][] = ['pending', 'processing'];

interface JobStatusListProps {
  /** Bumped by the parent right after a submission -- forces an immediate
   * re-fetch instead of waiting for the next poll tick, so a just-submitted
   * job appears in the list right away (the "pending state shows up
   * immediately" convention from AlertBanner's own poll-and-diff shape). */
  refreshSignal: number;
}

/** Same poll-and-diff shape as components/AlertBanner.tsx -- a plain list
 * here rather than a floating overlay, since a lookup job's result is
 * something an officer checks back on, not an interrupt-worthy event (that
 * part is handled by the existing push notification, see
 * routers/anpr_jobs.py's PATCH callback). */
export function JobStatusList({ refreshSignal }: JobStatusListProps) {
  const [jobs, setJobs] = useState<AnprJob[]>([]);
  const [pollError, setPollError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchJobs = async () => {
      try {
        const result = await anprJobsService.list();
        if (cancelled) return;
        setJobs(result);
        setPollError(null);
      } catch (err) {
        if (cancelled) return;
        setPollError(err instanceof Error ? err.message : 'Failed to load plate lookup jobs');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchJobs();
    const interval = setInterval(fetchJobs, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [refreshSignal]);

  if (loading) {
    return <p className="text-xs text-slate-500">Loading your plate lookup jobs…</p>;
  }

  if (pollError) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-signal-red">
        <AlertTriangle size={13} /> {pollError}
      </p>
    );
  }

  if (jobs.length === 0) {
    return <p className="text-xs text-slate-500">No plate lookup submissions yet.</p>;
  }

  const visibleJobs = expanded ? jobs : jobs.slice(0, COLLAPSED_COUNT);
  const hiddenCount = jobs.length - visibleJobs.length;

  const handleCancel = async (e: React.MouseEvent, jobId: number) => {
    // Rows are <Link>s -- without these the click would also navigate to
    // the job's detail page instead of just cancelling it in place.
    e.preventDefault();
    e.stopPropagation();
    setCancelError(null);
    setCancellingId(jobId);
    try {
      const updated = await anprJobsService.cancel(jobId);
      setJobs((prev) => prev.map((j) => (j.id === jobId ? updated : j)));
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'Failed to cancel job');
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <div>
      {cancelError && (
        <p className="flex items-center gap-1.5 text-xs text-signal-red mb-2">
          <AlertTriangle size={13} /> {cancelError}
        </p>
      )}
      <div className="divide-y divide-line border border-line rounded-lg overflow-hidden">
        {visibleJobs.map((job) => {
          const status = STATUS_STYLES[job.status];
          const StatusIcon = status.icon;
          const cancellable = CANCELLABLE_STATUSES.includes(job.status);
          return (
            <Link
              key={job.id}
              href={`/plate-lookup/${job.id}`}
              className="flex items-center gap-3 px-4 py-3 bg-panel hover:bg-panel-raised transition"
            >
              <StatusIcon size={16} className={`shrink-0 ${status.className} ${job.status === 'processing' ? 'animate-spin' : ''}`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">
                  {inputTypeLabel(job.input_type)} &middot; {job.district}
                </p>
                <p className="text-[11px] text-slate-500">
                  {status.label} &middot; {timeAgo(job.created_at)}
                  {job.status === 'failed' && job.error_message ? ` — ${job.error_message}` : ''}
                </p>
              </div>
              {cancellable && (
                <button
                  type="button"
                  onClick={(e) => handleCancel(e, job.id)}
                  disabled={cancellingId === job.id}
                  className="shrink-0 text-[11px] text-slate-400 hover:text-signal-red border border-line hover:border-signal-red rounded px-2 py-1 transition disabled:opacity-50"
                >
                  {cancellingId === job.id ? 'Cancelling…' : 'Cancel'}
                </button>
              )}
            </Link>
          );
        })}
      </div>
      {jobs.length > COLLAPSED_COUNT && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-xs text-command hover:underline"
        >
          {expanded ? 'Show less' : `Show ${hiddenCount} more`}
        </button>
      )}
    </div>
  );
}
