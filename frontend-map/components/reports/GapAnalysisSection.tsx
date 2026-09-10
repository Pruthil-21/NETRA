'use client';

import React, { useEffect, useState } from 'react';
import { Target, MapPinOff, AlertTriangle } from 'lucide-react';
import {
  fetchGapAnalysisReport,
  fetchCoverageTargets,
  deleteCoverageTarget,
  GapAnalysisReport,
  CoverageTarget,
} from '@/services/coverageTargetsService';
import { usePermissions } from '@/hooks/usePermissions';

function SectionCard({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: React.ElementType;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-panel border border-line rounded-lg p-4">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-white uppercase tracking-wide mb-3">
        <Icon size={13} className="text-slate-500" />
        {title} <span className="text-slate-500 normal-case font-normal">({count})</span>
      </h3>
      {children}
    </div>
  );
}

function TableHead({ columns }: { columns: string[] }) {
  return (
    <thead>
      <tr className="text-slate-500 text-left border-b border-line">
        {columns.map((col) => (
          <th key={col} className="pb-2 font-semibold text-[10px] uppercase tracking-wider">
            {col}
          </th>
        ))}
      </tr>
    </thead>
  );
}

export function GapAnalysisSection() {
  const [report, setReport] = useState<GapAnalysisReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targets, setTargets] = useState<CoverageTarget[] | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const { has } = usePermissions();

  useEffect(() => {
    fetchGapAnalysisReport()
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load gap analysis'));
  }, []);

  const loadTargets = () => {
    fetchCoverageTargets()
      .then(setTargets)
      .catch((err) => setTargetsError(err instanceof Error ? err.message : 'Failed to load coverage targets'));
  };

  useEffect(() => {
    loadTargets();
  }, []);

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    try {
      await deleteCoverageTarget(id);
      loadTargets();
    } catch (err) {
      setTargetsError(err instanceof Error ? err.message : 'Failed to delete coverage target');
    } finally {
      setDeletingId(null);
    }
  };

  if (error) return <p className="text-signal-red text-xs">{error}</p>;
  if (!report) return <p className="text-slate-500 text-xs">Loading gap analysis…</p>;

  return (
    <div className="flex flex-col gap-3">
      <SectionCard icon={Target} title="Coverage Targets" count={targets?.length ?? 0}>
        {targetsError ? (
          <p className="text-signal-red text-xs">{targetsError}</p>
        ) : !targets ? (
          <p className="text-slate-500 text-xs">Loading coverage targets…</p>
        ) : targets.length === 0 ? (
          <p className="text-slate-500 text-xs">No coverage targets defined.</p>
        ) : (
          <table className="w-full text-xs">
            <TableHead columns={['Name', 'District', 'Priority', '']} />
            <tbody>
              {targets.map((t) => (
                <tr key={t.id} className="border-t border-line text-slate-300">
                  <td className="py-2 text-white">{t.name}</td>
                  <td className="py-2 text-slate-400">{t.district}</td>
                  <td className="py-2 text-slate-400 capitalize">{t.priority}</td>
                  <td className="py-2 text-right">
                    {has('manage_cameras') && (
                      <button
                        type="button"
                        onClick={() => handleDelete(t.id)}
                        disabled={deletingId === t.id}
                        className="text-signal-red hover:text-signal-red/80 disabled:opacity-50 text-[11px]"
                      >
                        {deletingId === t.id ? 'Removing…' : 'Delete'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <SectionCard icon={MapPinOff} title="Uncovered Zones" count={report.uncovered_zones.length}>
        {report.uncovered_zones.length === 0 ? (
          <p className="text-slate-500 text-xs">No coverage gaps found.</p>
        ) : (
          <table className="w-full text-xs">
            <TableHead columns={['Target', 'District', 'Nearest Camera Distance']} />
            <tbody>
              {report.uncovered_zones.map((z) => (
                <tr key={z.target_id} className="border-t border-line">
                  <td className="py-2 text-white">{z.name}</td>
                  <td className="py-2 text-slate-400">{z.district}</td>
                  <td className="py-2 text-signal-red">
                    {z.distance_meters !== null ? `${Math.round(z.distance_meters)}m` : 'No cameras at all'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <SectionCard icon={AlertTriangle} title="Ageing Infrastructure" count={report.ageing_infrastructure.length}>
        {report.ageing_infrastructure.length === 0 ? (
          <p className="text-slate-500 text-xs">No ageing cameras flagged.</p>
        ) : (
          <table className="w-full text-xs">
            <TableHead columns={['Camera', 'District', 'Age', 'Degraded Events (90d)']} />
            <tbody>
              {report.ageing_infrastructure.map((c) => (
                <tr key={c.camera_id} className="border-t border-line">
                  <td className="py-2 text-white">{c.name}</td>
                  <td className="py-2 text-slate-400">{c.district}</td>
                  <td className="py-2 text-slate-400">{Math.floor(c.age_days / 365)}y</td>
                  <td className="py-2 text-amber-400">{c.degraded_transition_count_90d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
    </div>
  );
}
