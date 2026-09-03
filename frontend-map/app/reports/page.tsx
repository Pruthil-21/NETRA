'use client';

import React from 'react';
import { GapAnalysisSection } from '@/components/reports/GapAnalysisSection';

export default function ReportsPage() {
  return (
    <main className="flex-1 overflow-y-auto p-4 sm:p-6 min-h-0 w-full">
      <h1 className="text-sm font-semibold text-white uppercase tracking-wide mb-4">Reports</h1>
      <GapAnalysisSection />
    </main>
  );
}
