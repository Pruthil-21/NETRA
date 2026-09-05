'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, ScrollText, Search, ChevronDown } from 'lucide-react';
import { adminService, AuditLogOut } from '@/services/adminService';

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}

// Every mutating admin/registry action writes here via audit_service.log --
// this is the first (and only) place any of it is actually readable, rather
// than sitting in the database with no UI at all.
export function AuditLogSection() {
  const [logs, setLogs] = useState<AuditLogOut[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [badgeFilter, setBadgeFilter] = useState('');
  const [resourceFilter, setResourceFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const load = (opts: { cursor?: number; append?: boolean } = {}) => {
    const setBusy = opts.append ? setLoadingMore : setLoading;
    setBusy(true);
    setLoadError(null);
    adminService
      .listAuditLogs({
        badge_number: badgeFilter || undefined,
        resource_type: resourceFilter || undefined,
        from: dateFrom ? new Date(dateFrom).toISOString() : undefined,
        to: dateTo ? new Date(dateTo).toISOString() : undefined,
        cursor: opts.cursor,
      })
      .then((page) => {
        setLogs((prev) => (opts.append ? [...prev, ...page.logs] : page.logs));
        setNextCursor(page.next_cursor);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load audit logs'))
      .finally(() => setBusy(false));
  };

  // Initial load only -- filter changes apply on explicit "Apply filters" so a
  // half-typed badge number doesn't refetch on every keystroke.
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="mt-8">
      <div className="flex items-center gap-3 mb-1">
        <span className="inline-flex p-2 bg-slate-500/10 border border-slate-500/30 text-slate-400 rounded-lg">
          <ScrollText size={18} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide">Audit Log</h2>
          <p className="text-[11px] text-slate-500">Every sensitive action, with who did it and when</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2.5 items-end">
        <div>
          <label htmlFor="audit-badge" className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
            Badge Number
          </label>
          <input
            id="audit-badge"
            value={badgeFilter}
            onChange={(e) => setBadgeFilter(e.target.value)}
            placeholder="e.g. GJ-1042"
            className="bg-ink border border-line rounded-md px-2.5 py-1.5 text-xs text-white w-36 focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
          />
        </div>
        <div>
          <label htmlFor="audit-resource" className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
            Resource Type
          </label>
          <input
            id="audit-resource"
            value={resourceFilter}
            onChange={(e) => setResourceFilter(e.target.value)}
            placeholder="e.g. camera"
            className="bg-ink border border-line rounded-md px-2.5 py-1.5 text-xs text-white w-32 focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
          />
        </div>
        <div>
          <label htmlFor="audit-from" className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
            From
          </label>
          <input
            id="audit-from"
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="bg-ink border border-line rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
          />
        </div>
        <div>
          <label htmlFor="audit-to" className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
            To
          </label>
          <input
            id="audit-to"
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="bg-ink border border-line rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
          />
        </div>
        <button
          type="button"
          onClick={() => load()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
        >
          <Search size={12} />
          Apply
        </button>
      </div>

      <div className="mt-4">
        {loadError && (
          <div className="flex items-start gap-2.5 p-3 mb-4 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-semibold">Failed to load audit logs</p>
              <p className="text-[11px] text-signal-red/80">{loadError}</p>
            </div>
            <button
              type="button"
              onClick={() => load()}
              className="ml-auto shrink-0 text-[11px] px-2.5 py-1 rounded bg-panel-raised border border-line text-slate-200 hover:text-white"
            >
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col gap-2 animate-pulse" aria-label="Loading audit logs">
            {[1, 2, 3, 4].map((item) => (
              <div key={item} className="h-8 bg-panel-raised rounded" />
            ))}
          </div>
        ) : !loadError && logs.length === 0 ? (
          <div className="flex flex-col items-center text-center gap-2 py-16 text-slate-500">
            <ScrollText size={28} className="text-slate-600" />
            <p className="text-xs font-semibold text-slate-400">No audit entries match these filters</p>
          </div>
        ) : (
          <div className="border border-line rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-panel-raised text-slate-500 text-[10px] uppercase tracking-wider">
                    <th className="text-left font-semibold px-3 py-2">Timestamp</th>
                    <th className="text-left font-semibold px-3 py-2">Badge</th>
                    <th className="text-left font-semibold px-3 py-2">Action</th>
                    <th className="text-left font-semibold px-3 py-2">Resource</th>
                    <th className="text-left font-semibold px-3 py-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} className="border-t border-line hover:bg-panel-raised/50">
                      <td className="px-3 py-2 font-mono text-slate-400 whitespace-nowrap">{formatTimestamp(log.timestamp)}</td>
                      <td className="px-3 py-2 font-mono text-slate-300">{log.badge_number ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-200">{log.action}</td>
                      <td className="px-3 py-2 text-slate-400">
                        {log.resource_type}
                        {log.resource_id != null && <span className="text-slate-600"> #{log.resource_id}</span>}
                      </td>
                      <td className="px-3 py-2 text-slate-500">{log.reason_code ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {nextCursor != null && (
              <div className="p-2.5 border-t border-line bg-panel-raised/30 flex justify-center">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => load({ cursor: nextCursor, append: true })}
                  className="inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded bg-panel-raised border border-line text-slate-300 hover:text-white disabled:opacity-50"
                >
                  <ChevronDown size={12} />
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export default AuditLogSection;
