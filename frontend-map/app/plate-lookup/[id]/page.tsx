'use client';

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, Clock, Loader2, XCircle, Search as SearchIcon } from 'lucide-react';
import { usePermissions } from '@/hooks/usePermissions';
import { anprJobsService, AnprJob } from '@/services/anprJobsService';

const POLL_INTERVAL_MS = 3000;

const STAGE_COPY: Record<AnprJob['status'], string> = {
  pending: 'Queued -- waiting to start.',
  processing: 'Extracting the plate from your submission…',
  completed: 'Done.',
  failed: 'This submission could not be processed.',
};

/** Dedicated, deep-linkable status page for one job (the async-job UX
 * convention: a long-running submission gets its own page a push
 * notification or the job list can point back to, not just a toast that's
 * gone by the time an officer checks). Polls only while pending/processing
 * -- stops once the job reaches a terminal state, same "don't poll what
 * can't change" instinct as VehicleSearchPanel's own poll loop. */
export default function PlateLookupJobPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { has, loading: permissionsLoading } = usePermissions();
  const jobId = Number(params.id);

  const [job, setJob] = useState<AnprJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!Number.isFinite(jobId)) return;
    let cancelled = false;

    const fetchJob = async () => {
      try {
        const result = await anprJobsService.get(jobId);
        if (cancelled) return;
        setJob(result);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load this job');
      }
    };

    fetchJob();
    const interval = setInterval(() => {
      if (job && (job.status === 'completed' || job.status === 'failed')) {
        clearInterval(interval);
        return;
      }
      fetchJob();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // job.status is read inside the interval closure deliberately (to stop
    // polling once terminal) without re-subscribing the whole effect on
    // every poll tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  if (permissionsLoading) return null;
  if (!has('run_anpr_lookup')) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <p className="text-sm text-slate-500">You don&apos;t have access to Manual Plate Lookup.</p>
      </main>
    );
  }

  return (
    <main className="flex-1 overflow-y-auto min-h-0 w-full p-4 sm:p-6">
      <div className="max-w-2xl mx-auto flex flex-col gap-5">
        <Link href="/plate-lookup" className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-white w-fit">
          <ArrowLeft size={13} /> Back to Plate Lookup
        </Link>

        {error && <p className="text-sm text-signal-red">{error}</p>}

        {job && (
          <section className="bg-panel border border-line rounded-lg p-5 flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <StatusIcon status={job.status} />
              <div>
                <h1 className="text-base font-semibold text-white">Plate Lookup #{job.id}</h1>
                <p className="text-xs text-slate-500">{STAGE_COPY[job.status]}</p>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <dt className="text-slate-500 uppercase tracking-wider text-[10px] mb-0.5">District</dt>
                <dd className="text-slate-200">{job.district}</dd>
              </div>
              <div>
                <dt className="text-slate-500 uppercase tracking-wider text-[10px] mb-0.5">Submitted</dt>
                <dd className="text-slate-200">{new Date(job.created_at).toLocaleString()}</dd>
              </div>
              {job.original_filename && (
                <div className="col-span-2">
                  <dt className="text-slate-500 uppercase tracking-wider text-[10px] mb-0.5">File</dt>
                  <dd className="text-slate-200 truncate">{job.original_filename}</dd>
                </div>
              )}
              {(job.recorded_at || job.clip_start) && (
                <div>
                  <dt className="text-slate-500 uppercase tracking-wider text-[10px] mb-0.5">Recorded At</dt>
                  <dd className="text-slate-200">
                    {new Date((job.recorded_at ?? job.clip_start) as string).toLocaleString()}
                  </dd>
                </div>
              )}
              {job.file_sha256 && (
                <div className="col-span-2">
                  <dt className="text-slate-500 uppercase tracking-wider text-[10px] mb-0.5">
                    SHA-256 (chain of custody)
                  </dt>
                  <dd className="text-slate-400 font-mono text-[11px] break-all">{job.file_sha256}</dd>
                </div>
              )}
            </dl>

            {job.status === 'failed' && job.error_message && (
              <p className="text-xs text-signal-red bg-signal-red/10 border border-signal-red/30 rounded px-3 py-2">
                {job.error_message}
              </p>
            )}

            {job.status === 'completed' && (
              <div className="flex flex-col gap-2">
                {job.results.length === 0 && (
                  <p className="text-xs text-slate-500">Completed, but no plate was reported.</p>
                )}
                {job.results.length > 0 && (
                  <>
                    <p className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase">
                      {job.results.length === 1
                        ? 'Extracted Plate'
                        : job.input_type === 'upload_image'
                        ? `${job.results.length} Plates Found (Nearest to Farthest)`
                        : `${job.results.length} Plates Found (In Order Detected)`}
                    </p>
                    <div className="flex flex-col divide-y divide-line border border-line rounded-lg overflow-hidden">
                      {job.results.map((result, i) => (
                        <div key={result.id} className="flex items-center gap-3 px-3 py-2.5 bg-panel-raised">
                          <span className="text-[10px] text-slate-500 font-mono w-4 shrink-0">{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-white font-mono">{result.plate_number}</p>
                            <p className="text-[11px] text-slate-500">
                              {result.detected_at
                                ? new Date(result.detected_at).toLocaleString()
                                : job.input_type === 'upload_image'
                                ? 'Single photo -- no timestamp'
                                : 'Recording time not provided -- no timestamp'}
                              {result.confidence != null && ` · ${Math.round(result.confidence * 100)}% confidence`}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => router.push(`/search?plate=${encodeURIComponent(result.plate_number)}`)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-semibold bg-command hover:bg-command-dim text-white shrink-0"
                          >
                            <SearchIcon size={12} />
                            View History
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function StatusIcon({ status }: { status: AnprJob['status'] }) {
  if (status === 'completed') return <CheckCircle2 size={22} className="text-signal-green shrink-0" />;
  if (status === 'failed') return <XCircle size={22} className="text-signal-red shrink-0" />;
  if (status === 'processing') return <Loader2 size={22} className="text-command shrink-0 animate-spin" />;
  return <Clock size={22} className="text-slate-400 shrink-0" />;
}
