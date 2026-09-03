'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, Cpu, Radio, Server } from 'lucide-react';
import { scaleCameraService } from '@/services/scaleCameraService';
import { ScaleSummary } from '@/types/scaleCamera';

export function ScaleSummaryCard() {
  const [summary, setSummary] = useState<ScaleSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    scaleCameraService
      .getSummary()
      .then(setSummary)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load summary'))
      .finally(() => setLoading(false));
  }, []);

  if (error) {
    return (
      <div className="flex items-center gap-2.5 p-4 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red text-xs">
        <AlertTriangle size={16} />
        Scale summary unavailable — {error}
      </div>
    );
  }

  return (
    <div className="border border-command/30 bg-command/5 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold text-white uppercase tracking-wide">Registry Scale Summary</h2>
        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-command/20 text-command border border-command/40">
          Simulation
        </span>
      </div>

      {loading ? (
        <div className="animate-pulse h-16 bg-panel-raised rounded" />
      ) : summary ? (
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 text-center">
          <Stat icon={<Server size={14} />} label="Registered" value={summary.total.toLocaleString()} />
          <Stat icon={<Cpu size={14} />} label="Edge Nodes" value={summary.edge_node_count.toLocaleString()} />
          <Stat icon={<Radio size={14} />} label="Real Streams" value={summary.real_stream_count.toLocaleString()} />
          <Stat label="Online" value={summary.online.toLocaleString()} valueClass="text-signal-green" />
          <Stat label="Degraded" value={summary.degraded.toLocaleString()} valueClass="text-signal-amber" />
          <Stat label="Offline" value={summary.offline.toLocaleString()} valueClass="text-signal-red" />
        </div>
      ) : null}

      <p className="mt-3 text-[10px] text-slate-500 leading-relaxed">
        The backend control plane is tested with {summary?.synthetic_count.toLocaleString() ?? '80,000'} synthetic
        camera records. This validates registry and API handling, not simultaneous video streams.
      </p>
    </div>
  );
}

function Stat({ icon, label, value, valueClass }: { icon?: React.ReactNode; label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      {icon && <span className="text-slate-500">{icon}</span>}
      <span className={`text-sm font-semibold ${valueClass ?? 'text-white'}`}>{value}</span>
      <span className="text-[9px] uppercase tracking-wider text-slate-500">{label}</span>
    </div>
  );
}
