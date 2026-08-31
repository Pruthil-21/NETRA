'use client';

import React, { useMemo, useState } from 'react';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { WallControls } from '@/components/wall/WallControls';
import { WallGrid, WallLayout } from '@/components/wall/WallGrid';

/** The app's home page: continuous multi-feed monitoring, what a dispatcher
 * actually watches for most of a shift -- the camera inventory/map (asset
 * lookup, used far less often) lives at /map instead of here. Sources the
 * same CameraRegistryContext the map uses, so Wall and Map always agree on
 * what cameras exist; only the presentation differs. */
export default function VideoWallPage() {
  const { filteredCameras, isLoading, error } = useCameraRegistry();
  const [layout, setLayout] = useState<WallLayout>('grid-9');
  const [searchTerm, setSearchTerm] = useState('');

  const visibleCameras = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return filteredCameras;
    return filteredCameras.filter(
      (cam) =>
        cam.name?.toLowerCase().includes(term) ||
        cam.dept?.toLowerCase().includes(term) ||
        String(cam.id).toLowerCase().includes(term)
    );
  }, [filteredCameras, searchTerm]);

  return (
    <main className="flex-1 overflow-y-auto p-4 sm:p-6 min-h-0 w-full">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-sm font-semibold text-white uppercase tracking-wide">Video Wall</h1>
          <p className="text-xs text-slate-500">
            {isLoading ? 'Connecting to camera registry…' : `${filteredCameras.length} camera${filteredCameras.length === 1 ? '' : 's'} registered`}
          </p>
        </div>
      </div>

      <WallControls layout={layout} setLayout={setLayout} searchTerm={searchTerm} setSearchTerm={setSearchTerm} />

      {isLoading && (
        <div className="flex items-center justify-center p-16 text-slate-500 text-xs">Loading camera feeds…</div>
      )}

      {!isLoading && error && (
        <div className="bg-panel border border-signal-red/40 text-signal-red p-4 rounded mb-4 text-xs">
          <p className="font-semibold">Organizer registry unavailable</p>
          <p className="text-slate-500 mt-1">{error} — showing {filteredCameras.length} other camera{filteredCameras.length === 1 ? '' : 's'}.</p>
        </div>
      )}

      {!isLoading && <WallGrid cameras={visibleCameras} layout={layout} />}
    </main>
  );
}
