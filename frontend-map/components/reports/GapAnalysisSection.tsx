'use client';

import React, { useEffect, useState } from 'react';
import { fetchGapAnalysisReport, GapAnalysisReport } from '@/services/coverageTargetsService';

export function GapAnalysisSection() {
  const [report, setReport] = useState<GapAnalysisReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchGapAnalysisReport()
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load gap analysis'));
  }, []);

  if (error) return <p className="text-signal-red text-xs">{error}</p>;
  if (!report) return <p className="text-slate-500 text-xs">Loading gap analysis…</p>;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-xs font-semibold text-white uppercase tracking-wide mb-2">
          Uncovered Zones ({report.uncovered_zones.length})
        </h3>
        {report.uncovered_zones.length === 0 ? (
          <p className="text-slate-500 text-xs">No coverage gaps found.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 text-left">
                <th className="pb-1">Target</th>
                <th className="pb-1">District</th>
                <th className="pb-1">Nearest Camera Distance</th>
              </tr>
            </thead>
            <tbody>
              {report.uncovered_zones.map((z) => (
                <tr key={z.target_id} className="border-t border-line">
                  <td className="py-1 text-white">{z.name}</td>
                  <td className="py-1 text-slate-400">{z.district}</td>
                  <td className="py-1 text-signal-red">
                    {z.distance_meters !== null ? `${Math.round(z.distance_meters)}m` : 'No cameras at all'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <h3 className="text-xs font-semibold text-white uppercase tracking-wide mb-2">
          Ageing Infrastructure ({report.ageing_infrastructure.length})
        </h3>
        {report.ageing_infrastructure.length === 0 ? (
          <p className="text-slate-500 text-xs">No ageing cameras flagged.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 text-left">
                <th className="pb-1">Camera</th>
                <th className="pb-1">District</th>
                <th className="pb-1">Age</th>
                <th className="pb-1">Degraded Events (90d)</th>
              </tr>
            </thead>
            <tbody>
              {report.ageing_infrastructure.map((c) => (
                <tr key={c.camera_id} className="border-t border-line">
                  <td className="py-1 text-white">{c.name}</td>
                  <td className="py-1 text-slate-400">{c.district}</td>
                  <td className="py-1 text-slate-400">{Math.floor(c.age_days / 365)}y</td>
                  <td className="py-1 text-amber-400">{c.degraded_transition_count_90d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
