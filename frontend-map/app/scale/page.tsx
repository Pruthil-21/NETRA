'use client';

import { ScaleSummaryCard } from '@/components/scale/ScaleSummaryCard';

export default function ScaleDemoPage() {
  return (
    <main className="flex-1 overflow-y-auto min-h-0 w-full p-6">
      <h1 className="text-sm font-semibold text-white uppercase tracking-wide">
        Scale Simulation — 80,000 Cameras
      </h1>
      <p className="text-xs text-slate-500 mt-1">Isolated synthetic control-plane demo. Later tasks in this plan fill this page in.</p>
      <div className="mt-4">
        <ScaleSummaryCard />
      </div>
    </main>
  );
}
