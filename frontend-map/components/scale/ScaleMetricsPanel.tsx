'use client';

import React from 'react';
import { Activity } from 'lucide-react';

interface ScaleMetricsPanelProps {
  initialLoadMs: number | null;
  apiRequestCount: number;
  memoryMb: number | null;
  interactions: { label: string; durationMs: number }[];
}

export function ScaleMetricsPanel({ initialLoadMs, apiRequestCount, memoryMb, interactions }: ScaleMetricsPanelProps) {
  const avgInteractionMs =
    interactions.length > 0 ? Math.round(interactions.reduce((sum, i) => sum + i.durationMs, 0) / interactions.length) : null;

  return (
    <div className="mt-4 border border-line rounded-lg bg-panel p-3">
      <div className="flex items-center gap-1.5 mb-2">
        <Activity size={12} className="text-slate-500" />
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Client-Side Metrics</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[11px]">
        <Metric label="Initial Load" value={initialLoadMs !== null ? `${Math.round(initialLoadMs)}ms` : '—'} />
        <Metric label="API Requests" value={String(apiRequestCount)} />
        <Metric label="Memory (JS Heap)" value={memoryMb !== null ? `${memoryMb}MB` : 'n/a'} />
        <Metric label="Avg Interaction" value={avgInteractionMs !== null ? `${avgInteractionMs}ms` : '—'} />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-slate-500 text-[9px] uppercase tracking-wider">{label}</p>
      <p className="text-white font-mono">{value}</p>
    </div>
  );
}
