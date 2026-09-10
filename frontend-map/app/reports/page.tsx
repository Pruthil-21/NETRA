'use client';

import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { GapAnalysisSection } from '@/components/reports/GapAnalysisSection';
import { ReportsSummarySection } from '@/components/reports/ReportsSummarySection';
import { TrafficTrendsSection } from '@/components/reports/TrafficTrendsSection';
import AddCoverageTargetModal from '@/components/registry/AddCoverageTargetModal';
import { usePermissions } from '@/hooks/usePermissions';

type ReportsTab = 'overview' | 'coverage' | 'traffic';

export default function ReportsPage() {
  const [showAddModal, setShowAddModal] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useState<ReportsTab>('overview');
  const { has } = usePermissions();
  // view_analytics is currently only enforced server-side (the Map page's
  // Density/Flow layers) -- this tab is its first real client-side gate,
  // same conditional-tab pattern the Alerts page uses for its Traffic tab.
  const canViewTraffic = has('view_analytics');

  return (
    <main className="flex-1 overflow-y-auto p-4 sm:p-6 min-h-0 w-full">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-white">Reports</h1>
        {tab === 'coverage' && has('manage_cameras') && (
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-slate-300 hover:text-white bg-panel-raised rounded border border-line text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
          >
            <Plus size={13} />
            Add Coverage Target
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5 mb-5">
        {([
          ['overview', 'Overview'],
          ['coverage', 'Coverage & Gaps'],
          ...(canViewTraffic ? [['traffic', 'Traffic Trends']] as const : []),
        ] as [ReportsTab, string][]).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`px-3 py-1.5 rounded text-xs font-semibold transition ${
              tab === value ? 'bg-command text-white' : 'text-slate-400 hover:text-white hover:bg-panel-raised'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <ReportsSummarySection />}
      {tab === 'coverage' && <GapAnalysisSection key={refreshKey} />}
      {tab === 'traffic' && canViewTraffic && <TrafficTrendsSection />}

      {showAddModal && (
        <AddCoverageTargetModal
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            setShowAddModal(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </main>
  );
}
