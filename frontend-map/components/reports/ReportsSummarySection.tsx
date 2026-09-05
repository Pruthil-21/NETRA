'use client';

import React, { useEffect, useState } from 'react';
import { fetchReportSummary, ReportSummary } from '@/services/coverageTargetsService';
import { formatDuration } from '@/hooks/useCameraUptime';

function BreakdownTable({ title, counts }: { title: string; counts: Record<string, number> }) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (
    <div>
      <h3 className="text-xs font-semibold text-white uppercase tracking-wide mb-2">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-slate-500 text-xs">No data.</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {rows.map(([label, count]) => (
              <tr key={label} className="border-t border-line">
                <td className="py-1 text-slate-300 capitalize">{label}</td>
                <td className="py-1 text-white text-right font-mono">{count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function ReportsSummarySection() {
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchReportSummary()
      .then(setSummary)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load report summary'));
  }, []);

  if (error) return <p className="text-signal-red text-xs">{error}</p>;
  if (!summary) return <p className="text-slate-500 text-xs">Loading summary…</p>;

  // null fields mean backend-watchlist's schema isn't applied in this
  // environment yet -- omit the whole row rather than showing a confusing 0.
  const activityRows: [string, string][] = [
    ['Alerts (24h)', summary.alerts_last_24h === null ? '—' : String(summary.alerts_last_24h)],
    ['Detections (24h)', summary.detections_last_24h === null ? '—' : String(summary.detections_last_24h)],
    ['Blacklist entries (24h)', summary.blacklist_entries_last_24h === null ? '—' : String(summary.blacklist_entries_last_24h)],
    ['Avg. alert response', summary.avg_alert_response_seconds === null ? '—' : formatDuration(summary.avg_alert_response_seconds)],
  ];

  return (
    <div className="flex flex-col gap-4 mb-6">
      <div>
        <h3 className="text-xs font-semibold text-white uppercase tracking-wide mb-1">Registry Overview</h3>
        <p className="text-xs text-slate-400">
          {summary.total_cameras} camera{summary.total_cameras === 1 ? '' : 's'} across{' '}
          {Object.keys(summary.cameras_by_department).length} department
          {Object.keys(summary.cameras_by_department).length === 1 ? '' : 's'}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <BreakdownTable title="By Department" counts={summary.cameras_by_department} />
        <BreakdownTable title="By Connectivity" counts={summary.cameras_by_connectivity_status} />
        <BreakdownTable title="By Health" counts={summary.cameras_by_health_status} />
      </div>

      <div>
        <h3 className="text-xs font-semibold text-white uppercase tracking-wide mb-2">Activity</h3>
        <table className="w-full text-xs max-w-sm">
          <tbody>
            {activityRows.map(([label, value]) => (
              <tr key={label} className="border-t border-line">
                <td className="py-1 text-slate-300">{label}</td>
                <td className="py-1 text-white text-right font-mono">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
