'use client';

import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { CameraRegistryProvider, useCameraRegistry } from '@/context/CameraRegistryContext';
import { VehicleSearchPanel } from '@/components/search/VehicleSearchPanel';
import { Camera } from '@/types/camera';
import { Detection } from '@/types/detection';
import { Shield, ArrowLeft } from 'lucide-react';

const CameraMap = dynamic(
  () => import('@/components/map/CameraMap').then((mod) => mod.CameraMap || mod.default),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex items-center justify-center bg-slate-950 text-slate-400 text-sm">
        <div className="flex flex-col items-center gap-2">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <span>Loading map…</span>
        </div>
      </div>
    ),
  }
);

function VehicleSearchDashboard() {
  const router = useRouter();
  const { cameras, isLoading, error } = useCameraRegistry();
  const [sightings, setSightings] = useState<Detection[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
      <header className="h-14 border-b border-slate-800 px-6 flex items-center gap-4 bg-slate-900/80 shrink-0">
        <button
          type="button"
          aria-label="Back to camera registry"
          onClick={() => router.push('/')}
          className="p-1.5 text-slate-400 hover:text-white bg-slate-800 rounded border border-slate-700"
        >
          <ArrowLeft size={14} />
        </button>
        <Shield className="text-blue-500" size={22} />
        <h1 className="font-bold text-sm tracking-wider uppercase text-white">Vehicle Movement Search</h1>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <aside className="w-80 shrink-0 h-full flex flex-col bg-slate-900 border-r border-slate-800 overflow-hidden">
          {isLoading ? (
            <div className="p-6 text-center text-xs text-slate-500">Loading camera registry…</div>
          ) : error ? (
            <div className="p-6 text-center text-xs text-rose-400">
              Failed to load camera registry: {error}
            </div>
          ) : (
            <VehicleSearchPanel
              cameras={cameras}
              onResultsChange={setSightings}
              onSelectSighting={setSelectedCamera}
            />
          )}
        </aside>

        <main className="flex-1 relative">
          <CameraMap
            cameras={cameras}
            selectedCamera={selectedCamera}
            onSelectCamera={setSelectedCamera}
            sightings={sightings}
          />
        </main>
      </div>
    </div>
  );
}

export default function VehicleSearchPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const auth = localStorage.getItem('netra_authenticated');
    if (!auth) {
      router.replace('/login');
    } else {
      setAuthChecked(true);
    }
  }, [router]);

  if (!authChecked) return null;

  return (
    <CameraRegistryProvider>
      <VehicleSearchDashboard />
    </CameraRegistryProvider>
  );
}
