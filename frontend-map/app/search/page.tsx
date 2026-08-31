'use client';

import React, { useState } from 'react';
import dynamic from 'next/dynamic';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { VehicleSearchPanel } from '@/components/search/VehicleSearchPanel';
import { SightingAlertToasts } from '@/components/search/SightingAlertToasts';
import CameraDetailDrawer from '@/components/registry/CameraDetailDrawer';
import { Camera } from '@/types/camera';
import { Detection } from '@/types/detection';

const CameraMap = dynamic(
  () => import('@/components/map/CameraMap').then((mod) => mod.CameraMap || mod.default),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex items-center justify-center bg-ink text-slate-500 text-xs">
        <div className="flex flex-col items-center gap-2">
          <div className="w-6 h-6 border-2 border-command border-t-transparent rounded-full animate-spin"></div>
          <span className="font-mono">LOADING GIS ENGINE…</span>
        </div>
      </div>
    ),
  }
);

/** Investigative tool: "where has this plate been seen" -- reached
 * on-demand (a lead comes in), unlike the Video Wall's continuous
 * monitoring. Nav/auth/header live in the shared AppShell. */
export default function VehicleSearchPage() {
  const { cameras, isLoading, error } = useCameraRegistry();
  const [sightings, setSightings] = useState<Detection[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);

  return (
    <div className="flex-1 flex overflow-hidden min-h-0">
      <aside className="w-80 shrink-0 h-full flex flex-col bg-panel border-r border-line overflow-hidden">
        {isLoading ? (
          <div className="p-6 text-center text-xs text-slate-500">Loading camera registry…</div>
        ) : cameras.length === 0 ? (
          // Only truly blocking when there's nothing to search at all --
          // an organizer-registry fetch failure alone (error set, but
          // manual/test-rig/vehicle-trace-demo cameras still loaded via
          // CameraRegistryContext) shouldn't hide the whole search panel.
          <div className="p-6 text-center text-xs text-signal-red">
            Failed to load camera registry: {error}
          </div>
        ) : (
          <>
            {error && (
              <div className="px-3 py-1.5 text-[10px] text-amber-400 bg-amber-500/10 border-b border-amber-500/20">
                Organizer registry unavailable ({error}) — showing {cameras.length} other camera
                {cameras.length === 1 ? '' : 's'}.
              </div>
            )}
            <VehicleSearchPanel
              cameras={cameras}
              onResultsChange={setSightings}
              onSelectSighting={setSelectedCamera}
            />
          </>
        )}
      </aside>

      <main className="flex-1 flex flex-col overflow-hidden">
        <h1 className="sr-only">Vehicle movement search</h1>
        <div className="flex-1 relative">
          <CameraMap
            cameras={cameras}
            selectedCamera={selectedCamera}
            onSelectCamera={setSelectedCamera}
            sightings={sightings}
          />
          <SightingAlertToasts sightings={sightings} cameras={cameras} />
        </div>
        {/* Clicking a sighting (map point or sidebar row) sets selectedCamera,
            which mounts this with key={camera.id} inside CameraDetailDrawer ->
            CameraLivePlayer -> WebRTCPlayer. Switching cameras remounts that
            chain fresh, and WebRTCPlayer's own cleanup tears down the prior
            WHEP session -- so "open feed on click" / "close previous on
            switch" both fall out of existing lifecycle, no new wiring needed. */}
        {selectedCamera && <CameraDetailDrawer camera={selectedCamera} />}
      </main>
    </div>
  );
}
