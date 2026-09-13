'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Video, ImageIcon, Film, ScanSearch } from 'lucide-react';
import { usePermissions } from '@/hooks/usePermissions';
import { UploadTab } from '@/components/plateLookup/UploadTab';
import { FromArchiveTab } from '@/components/plateLookup/FromArchiveTab';
import { JobStatusList } from '@/components/plateLookup/JobStatusList';

type TabId = 'video' | 'image' | 'archive';

const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: 'video', label: 'Upload Video', icon: Video },
  { id: 'image', label: 'Upload Photo', icon: ImageIcon },
  { id: 'archive', label: 'From Archive', icon: Film },
];

/** Manual Plate Lookup: an officer submits a video/photo of a vehicle (or
 * marks a camera+timestamp range already in Archive), it's run through
 * ml-anpr, and the extracted plate (if any) becomes a real sighting --
 * same detections/alerts/map-trace pipeline every live camera detection
 * already goes through, see backend-watchlist's anpr_jobs_service.py. */
export default function PlateLookupPage() {
  const router = useRouter();
  const { has, loading } = usePermissions();
  const [activeTab, setActiveTab] = useState<TabId>('video');
  const [refreshSignal, setRefreshSignal] = useState(0);

  if (loading) {
    return <main className="flex-1 p-6 text-sm text-slate-500">Loading…</main>;
  }

  if (!has('run_anpr_lookup')) {
    return (
      <main className="flex-1 overflow-y-auto min-h-0 w-full flex items-center justify-center">
        <p className="text-sm text-slate-500">You don&apos;t have access to Manual Plate Lookup.</p>
      </main>
    );
  }

  const handleSubmitted = (jobId: number) => {
    setRefreshSignal((n) => n + 1);
    router.push(`/plate-lookup/${jobId}`);
  };

  return (
    <main className="flex-1 overflow-y-auto min-h-0 w-full p-4 sm:p-6">
      <div className="max-w-5xl mx-auto flex flex-col gap-6">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-white">
            <ScanSearch size={20} className="text-command" />
            Manual Plate Lookup
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Submit a video clip, a photo, or a marked Archive range for automatic plate extraction --
            a result becomes a real sighting, cross-checked against the watchlist the same as any live
            camera detection.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-6">
          <section className="bg-panel border border-line rounded-lg p-4 sm:p-5">
            <div className="flex items-center gap-1 border-b border-line mb-4 -mt-1">
              {TABS.map((tab) => {
                const Icon = tab.icon;
                const isActive = tab.id === activeTab;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 -mb-px transition ${
                      isActive ? 'border-command text-white' : 'border-transparent text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    <Icon size={14} />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {activeTab === 'video' && <UploadTab kind="video" onSubmitted={handleSubmitted} />}
            {activeTab === 'image' && <UploadTab kind="image" onSubmitted={handleSubmitted} />}
            {activeTab === 'archive' && <FromArchiveTab onSubmitted={handleSubmitted} />}
          </section>

          <section>
            <h2 className="text-xs font-semibold tracking-wider text-slate-400 uppercase mb-2">
              Your Submissions
            </h2>
            <JobStatusList refreshSignal={refreshSignal} />
          </section>
        </div>
      </div>
    </main>
  );
}
