'use client';

import React, { useEffect, useState } from 'react';
import { Camera, Radio, ShieldAlert, Fingerprint, Clock, UserX } from 'lucide-react';
import { fetchReportSummary, ReportSummary } from '@/services/coverageTargetsService';
import { formatDuration } from '@/hooks/useCameraUptime';

function KpiCard({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="bg-panel border border-line rounded-lg p-4">
      <div className="flex items-center gap-1.5 text-slate-500 mb-2">
        <Icon size={13} />
        <span className="text-[10px] font-semibold tracking-wider uppercase">{label}</span>
      </div>
      <p className="text-2xl font-semibold text-white font-mono">{value}</p>
    </div>
  );
}

function BreakdownCard({ title, counts }: { title: string; counts: Record<string, number> }) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (
    <div className="bg-panel border border-line rounded-lg p-4">
      <h3 className="text-xs font-semibold text-white uppercase tracking-wide mb-3">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-slate-500 text-xs">No data.</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {rows.map(([label, count]) => (
              <tr key={label} className="border-t border-line first:border-t-0">
                <td className="py-1.5 text-slate-300 capitalize">{label}</td>
                <td className="py-1.5 text-white text-right font-mono">{count}</td>
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

  const onlineCount = summary.cameras_by_connectivity_status['online'] ?? 0;

  return (
    <div className="flex flex-col gap-6 mb-8">
      <div>
        <h2 className="text-xs font-semibold text-white uppercase tracking-wide mb-3">Registry Overview</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <KpiCard icon={Camera} label="Total Cameras" value={String(summary.total_cameras)} />
          <KpiCard icon={Radio} label="Online Now" value={`${onlineCount} / ${summary.total_cameras}`} />
          <KpiCard
            icon={ShieldAlert}
            label="Alerts (24h)"
            value={summary.alerts_last_24h === null ? '—' : String(summary.alerts_last_24h)}
          />
          <KpiCard
            icon={Fingerprint}
            label="Detections (24h)"
            value={summary.detections_last_24h === null ? '—' : String(summary.detections_last_24h)}
          />
          <KpiCard
            icon={UserX}
            label="Blacklist Hits (24h)"
            value={summary.blacklist_entries_last_24h === null ? '—' : String(summary.blacklist_entries_last_24h)}
          />
          <KpiCard
            icon={Clock}
            label="Avg. Alert Response"
            value={summary.avg_alert_response_seconds === null ? '—' : formatDuration(summary.avg_alert_response_seconds)}
          />
        </div>
      </div>

      <div>
        <h2 className="text-xs font-semibold text-white uppercase tracking-wide mb-3">Registry Breakdown</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <BreakdownCard title="By Department" counts={summary.cameras_by_department} />
          <BreakdownCard title="By Connectivity" counts={summary.cameras_by_connectivity_status} />
          <BreakdownCard title="By Health" counts={summary.cameras_by_health_status} />
        </div>
      </div>
    </div>
  );
}
