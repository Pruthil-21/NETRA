'use client';

import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { GapAnalysisSection } from '@/components/reports/GapAnalysisSection';
import { ReportsSummarySection } from '@/components/reports/ReportsSummarySection';
import AddCoverageTargetModal from '@/components/registry/AddCoverageTargetModal';
import { usePermissions } from '@/hooks/usePermissions';

export default function ReportsPage() {
  const [showAddModal, setShowAddModal] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const { has } = usePermissions();

  return (
    <main className="flex-1 overflow-y-auto p-4 sm:p-6 min-h-0 w-full">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-sm font-semibold text-white uppercase tracking-wide">Reports</h1>
        {has('manage_cameras') && (
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

      <ReportsSummarySection />
      <GapAnalysisSection key={refreshKey} />

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
