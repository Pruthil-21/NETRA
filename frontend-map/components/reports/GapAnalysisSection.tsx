'use client';

import React, { useEffect, useState } from 'react';
import { Target, MapPinOff, AlertTriangle, ShieldCheck, MapPinPlus, Download } from 'lucide-react';
import {
  fetchGapAnalysisReport,
  fetchCoverageTargets,
  deleteCoverageTarget,
  openGapAnalysisReport,
  GapAnalysisReport,
  CoverageTarget,
} from '@/services/coverageTargetsService';
import { usePermissions } from '@/hooks/usePermissions';

// Reserve red/amber specifically for severity (not decoration) against the
// dark panel background -- slate is the neutral/"fine" state. Same
// three-tone vocabulary TrafficAlertsSection's NEW/ACKNOWLEDGED/DISMISSED
// pills already use, applied here to priority/distance/degradation instead
// of an alert lifecycle.
type Tone = 'red' | 'amber' | 'slate';

const TONE_STYLES: Record<Tone, string> = {
  red: 'bg-signal-red/15 text-signal-red border-signal-red/30',
  amber: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  slate: 'bg-slate-700/30 text-slate-400 border-slate-600/40',
};

function SeverityBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-semibold whitespace-nowrap ${TONE_STYLES[tone]}`}>
      {children}
    </span>
  );
}

// A small at-a-glance scale next to the raw distance number, not a
// replacement for it -- capped at 1km, since anything past that is equally
// "far" for a coverage gap and a linear bar would just look pegged.
function DistanceBar({ meters, tone }: { meters: number | null; tone: Tone }) {
  const pct = meters === null ? 100 : Math.min(100, Math.round((meters / 1000) * 100));
  const barColor = tone === 'red' ? 'bg-signal-red' : tone === 'amber' ? 'bg-amber-500' : 'bg-slate-500';
  return (
    <span className="inline-block w-14 h-1.5 rounded-full bg-ink overflow-hidden align-middle">
      <span className={`block h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

function priorityBadge(priority: string) {
  const tone: Tone = priority === 'high' ? 'red' : priority === 'medium' ? 'amber' : 'slate';
  return <SeverityBadge tone={tone}>{priority}</SeverityBadge>;
}

function distanceTone(meters: number | null): Tone {
  return meters === null || meters >= 500 ? 'red' : 'amber';
}

// Backend's own honest, explainable risk_level (age + connectivity history
// only -- deliberately not a statistical failure-prediction model, see
// gap_analysis_service.compute_ageing_infrastructure's docstring) is now the
// authoritative signal, replacing what used to be a frontend-only re-derivation
// from degraded_transition_count_90d alone.
function riskTone(riskLevel: string): Tone {
  return riskLevel === 'high' ? 'red' : riskLevel === 'medium' ? 'amber' : 'slate';
}

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

function EmptyState({ icon: Icon, message }: { icon: React.ElementType; message: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 py-6 text-center">
      <Icon size={18} className="text-slate-600" />
      <p className="text-slate-500 text-xs">{message}</p>
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
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const { has } = usePermissions();

  const handleDownload = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      await openGapAnalysisReport();
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Failed to generate report');
    } finally {
      setDownloading(false);
    }
  };

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

  // A single headline number before the detail tables below -- the same
  // progressive-disclosure shape ReportsSummarySection's KPI cards already
  // establish for the Overview tab (one number to read at a glance, tables
  // for the deep dive).
  const coveredCount = targets ? Math.max(0, targets.length - report.uncovered_zones.length) : null;
  const coveragePct =
    targets && targets.length > 0 && coveredCount !== null ? Math.round((coveredCount / targets.length) * 100) : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          {downloadError && <p className="text-signal-red text-[11px]">{downloadError}</p>}
        </div>
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-line bg-panel text-slate-200 text-xs font-semibold hover:bg-panel-raised disabled:opacity-50 shrink-0"
          title="Open a printable, shareable copy of this report"
        >
          <Download size={13} />
          {downloading ? 'Generating…' : 'Download Report'}
        </button>
      </div>

      {coveragePct !== null && (
        <div className="bg-panel border border-line rounded-lg p-4 flex items-center gap-3">
          <span className="inline-flex p-2 bg-command/10 border border-command/30 text-command rounded-lg shrink-0">
            <ShieldCheck size={16} />
          </span>
          <div>
            <p className="text-2xl font-semibold text-white font-mono leading-none">
              {coveredCount} / {targets!.length} <span className="text-sm text-slate-400 font-sans font-normal">targets covered</span>
            </p>
            <p className="text-[11px] text-slate-500 mt-1">{coveragePct}% of coverage targets have a camera within range</p>
          </div>
        </div>
      )}

      <SectionCard icon={Target} title="Coverage Targets" count={targets?.length ?? 0}>
        {targetsError ? (
          <p className="text-signal-red text-xs">{targetsError}</p>
        ) : !targets ? (
          <p className="text-slate-500 text-xs">Loading coverage targets…</p>
        ) : targets.length === 0 ? (
          <EmptyState icon={Target} message="No coverage targets defined." />
        ) : (
          <table className="w-full text-xs">
            <TableHead columns={['Name', 'District', 'Priority', '']} />
            <tbody>
              {targets.map((t) => (
                <tr key={t.id} className="border-t border-line text-slate-300 hover:bg-panel-raised/60">
                  <td className="py-2 text-white">{t.name}</td>
                  <td className="py-2 text-slate-400">{t.district}</td>
                  <td className="py-2">{priorityBadge(t.priority)}</td>
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
          <EmptyState icon={MapPinOff} message="No coverage gaps found." />
        ) : (
          <table className="w-full text-xs">
            <TableHead columns={['Target', 'District', 'Priority', 'Nearest Camera']} />
            <tbody>
              {report.uncovered_zones.map((z) => {
                const tone = distanceTone(z.distance_meters);
                return (
                  <tr key={z.target_id} className="border-t border-line hover:bg-panel-raised/60">
                    <td className="py-2 text-white">{z.name}</td>
                    <td className="py-2 text-slate-400">{z.district}</td>
                    <td className="py-2">{priorityBadge(z.priority)}</td>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <SeverityBadge tone={tone}>{tone === 'red' ? 'Critical' : 'Gap'}</SeverityBadge>
                        <DistanceBar meters={z.distance_meters} tone={tone} />
                        <span className="font-mono text-slate-400">
                          {z.distance_meters !== null ? `${Math.round(z.distance_meters)}m` : 'no camera'}
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </SectionCard>

      <SectionCard icon={AlertTriangle} title="Ageing Infrastructure" count={report.ageing_infrastructure.length}>
        {report.ageing_infrastructure.length === 0 ? (
          <EmptyState icon={AlertTriangle} message="No ageing cameras flagged." />
        ) : (
          <table className="w-full text-xs">
            <TableHead columns={['Camera', 'District', 'Age', 'Degraded Events (90d)']} />
            <tbody>
              {report.ageing_infrastructure.map((c) => {
                const tone = riskTone(c.risk_level);
                return (
                  <tr key={c.camera_id} className="border-t border-line hover:bg-panel-raised/60">
                    <td className="py-2 text-white">{c.name}</td>
                    <td className="py-2 text-slate-400">{c.district}</td>
                    <td className="py-2 text-slate-400">{Math.floor(c.age_days / 365)}y</td>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <SeverityBadge tone={tone}>
                          {tone === 'red' ? 'High risk' : tone === 'amber' ? 'Watch' : 'Stable'}
                        </SeverityBadge>
                        <span className="font-mono text-slate-400">{c.degraded_transition_count_90d}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </SectionCard>

      <SectionCard icon={MapPinPlus} title="Recommended New Sites" count={report.placement_suggestions.length}>
        {report.placement_suggestions.length === 0 ? (
          <EmptyState icon={MapPinPlus} message="No uncovered checkpoints to suggest sites for." />
        ) : (
          <table className="w-full text-xs">
            <TableHead columns={['Suggested Site', 'District', 'Checkpoints Closed', 'Priority Score']} />
            <tbody>
              {report.placement_suggestions.map((p) => (
                <tr key={p.suggested_at_target_id} className="border-t border-line hover:bg-panel-raised/60">
                  <td className="py-2 text-white">{p.suggested_at_name}</td>
                  <td className="py-2 text-slate-400">{p.district}</td>
                  <td className="py-2 text-slate-400">{p.covers_target_ids.length}</td>
                  <td className="py-2 font-mono text-slate-400">{p.priority_weighted_score.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-[10px] text-slate-600 mt-2">
          Greedy set-cover, weighted by checkpoint priority — a best-effort recommendation, not a guaranteed-optimal placement.
        </p>
      </SectionCard>
    </div>
  );
}
