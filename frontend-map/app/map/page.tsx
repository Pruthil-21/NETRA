'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import CameraDetailDrawer from '@/components/registry/CameraDetailDrawer';
import { CameraRegistrySidebar } from '@/components/registry/CameraRegistrySidebar';
import { usePermissions } from '@/hooks/usePermissions';
import { TreeSelection } from '@/components/tree/DistrictAreaTree';
import { CameraInfoOverlay } from '@/components/overlay/CameraInfoOverlay';
import { MapFilterControl } from '@/components/map/MapFilterControl';
import { DensityLoadStatus } from '@/components/map/DensityCanvasLayer';
import { FlowLoadStatus } from '@/components/map/FlowCanvasLayer';
import { areasService, Area } from '@/services/areasService';

const CameraMap = dynamic(() => import('@/components/map/CameraMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-ink text-slate-500 text-xs">
      <div className="flex flex-col items-center gap-2">
        <div className="w-6 h-6 border-2 border-command border-t-transparent rounded-full animate-spin" />
        <span className="font-mono">LOADING GIS ENGINE…</span>
      </div>
    </div>
  ),
});

/** Camera inventory + coverage map -- "where are my assets and what shape
 * are they in," an on-demand lookup rather than something an officer stares
 * at continuously (that's the Dashboard, the app's home page). Nav,
 * auth, and the global header live in the shared AppShell; this page owns
 * only what's specific to it: the map itself. */
export default function MapPage() {
  const { cameras, filteredCameras, filters, selectedCamera, setSelectedCamera } = useCameraRegistry();
  const { scopeValue: homeDistrict } = usePermissions();
  const searchParams = useSearchParams();

  const [treeSelection, setTreeSelection] = useState<TreeSelection>(null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [hoveredCameraId, setHoveredCameraId] = useState<number | null>(null);
  // See app/page.tsx's identical ref for the full explanation: CameraMap's
  // per-marker hover-grace timer reports a clear (null) via onHoverChange
  // once its own grace period elapses, which happens right after the shared
  // CameraInfoOverlay opens and covers the marker -- without gating that
  // clear on "is the cursor actually over the overlay right now", the
  // overlay closes and reopens in a flicker loop.
  const overlayHoveredRef = useRef(false);
  // Reported by DensityCanvasLayer on every fetch attempt -- lifted here
  // (rather than left inside the canvas layer) so MapFilterControl, a
  // sibling of CameraMap rather than an ancestor, can show *why* the
  // density layer is empty: a permission error, a network failure, and a
  // genuinely quiet window all render zero heat blobs but mean very
  // different things to an officer looking at the map.
  const [densityStatus, setDensityStatus] = useState<DensityLoadStatus | null>(null);
  // Same lifted-status pattern as densityStatus above, for the Flow layer.
  const [flowStatus, setFlowStatus] = useState<FlowLoadStatus | null>(null);

  useEffect(() => {
    areasService.listAreas().then(setAreas).catch(() => {
      // Non-fatal: the tree just shows no areas until this succeeds/retries.
    });
  }, []);

  // "Locate on Map" (the registry tree's right-click menu, any page) lands
  // here as ?camera=<id> -- select it once the registry has actually
  // loaded, the same "apply once per distinct value, not once ever" ref
  // pattern as Archive's ?camera=&at= deep link, so clicking it again for a
  // *different* camera while already on this page still takes effect.
  // Selecting it is enough: CameraMap's MapController already flyTo()s the
  // selected camera, and CameraDetailDrawer already renders off the same
  // selectedCamera state.
  const requestedCameraId = searchParams.get('camera');
  const lastAppliedCameraId = useRef<string | null>(null);
  useEffect(() => {
    if (!requestedCameraId || lastAppliedCameraId.current === requestedCameraId || cameras.length === 0) return;
    const found = cameras.find((cam) => String(cam.id) === requestedCameraId);
    if (!found) return;
    lastAppliedCameraId.current = requestedCameraId;
    setSelectedCamera(found);
    setTreeSelection({ type: 'camera', value: found.id });
  }, [requestedCameraId, cameras, setSelectedCamera]);

  // Tree structure (districts/areas) always reflects the full registry, not
  // whatever CameraFilterBar currently narrows filteredCameras to -- otherwise
  // picking a department filter would make the tree lose branches out from
  // under the officer navigating it.
  const districts = useMemo(
    () => Array.from(new Set(cameras.map((cam) => cam.dept))).sort(),
    [cameras]
  );

  // Which of the *currently rendered* markers (filteredCameras -- the same
  // set passed to CameraMap below) fall under the tree's selection. Computed
  // against filteredCameras rather than the full registry so the pan/zoom
  // effect only ever frames cameras that are actually visible on the map.
  const highlightedCameraIds = useMemo(() => {
    if (!treeSelection) return undefined;
    let matches;
    if (treeSelection.type === 'district') {
      matches = filteredCameras.filter((cam) => cam.dept === treeSelection.value);
    } else if (treeSelection.type === 'camera') {
      matches = filteredCameras.filter((cam) => cam.id === treeSelection.value);
    } else {
      matches = filteredCameras.filter((cam) => cam.area_id === treeSelection.value);
    }
    return new Set(matches.map((cam) => cam.id));
  }, [treeSelection, filteredCameras]);

  const hoveredCamera = useMemo(
    () => (hoveredCameraId != null ? cameras.find((cam) => cam.id === hoveredCameraId) ?? null : null),
    [cameras, hoveredCameraId]
  );
  const hoveredAreaName = useMemo(
    () => areas.find((area) => area.id === hoveredCamera?.area_id)?.name ?? null,
    [areas, hoveredCamera]
  );

  return (
    <div className="flex-1 flex overflow-hidden relative min-h-0">
      <CameraRegistrySidebar
        districts={districts}
        areas={areas}
        cameras={cameras}
        selected={treeSelection}
        onSelect={(selection) => {
          setTreeSelection(selection);
          if (selection?.type === 'camera') {
            const found = cameras.find((cam) => cam.id === selection.value);
            if (found) setSelectedCamera(found);
          }
        }}
        homeDistrict={homeDistrict}
        enableDrag={false}
      />

      <main className="flex-1 flex flex-col h-full overflow-hidden">
        <div className="flex-1 flex overflow-hidden min-h-0">
          <div className="flex-1 relative">
            <CameraMap
              cameras={filteredCameras}
              selectedCamera={selectedCamera}
              onSelectCamera={setSelectedCamera}
              onHoverChange={(id) => {
                // A clear (null) while the cursor is over the overlay is the
                // spurious signal from the covered marker's own hover-grace
                // timer elapsing -- skip it; the overlay's own
                // onMouseLeaveOverlay below is what actually clears
                // hoveredCameraId once the cursor genuinely leaves it. A
                // non-null id is always a real hover-start and applies
                // immediately.
                if (id === null && overlayHoveredRef.current) return;
                setHoveredCameraId(id);
              }}
              highlightedCameraIds={highlightedCameraIds}
              hideMarkers={filters.mapLayer !== 'none'}
              showPoliceStations={filters.showPoliceStations}
              coverage={filters.mapLayer === 'coverage' ? { cameras: filteredCameras } : undefined}
              density={
                filters.mapLayer === 'density'
                  ? {
                      cameras: filteredCameras,
                      mode: filters.densityMode,
                      windowMinutes: filters.densityWindowMinutes,
                      hour: filters.densityHour,
                      onStatusChange: setDensityStatus,
                    }
                  : undefined
              }
              flow={
                filters.mapLayer === 'flow'
                  ? {
                      cameras: filteredCameras,
                      mode: filters.flowMode,
                      windowMinutes: filters.flowWindowMinutes,
                      hour: filters.flowHour,
                      onStatusChange: setFlowStatus,
                    }
                  : undefined
              }
            />
            <MapFilterControl
              densityStatus={filters.mapLayer === 'density' ? densityStatus : null}
              flowStatus={filters.mapLayer === 'flow' ? flowStatus : null}
            />
          </div>
        </div>
        <CameraDetailDrawer camera={selectedCamera} />
      </main>

      <CameraInfoOverlay
        camera={hoveredCamera}
        areaName={hoveredAreaName}
        onClose={() => setHoveredCameraId(null)}
        onMouseEnterOverlay={() => {
          overlayHoveredRef.current = true;
        }}
        onMouseLeaveOverlay={() => {
          overlayHoveredRef.current = false;
        }}
      />
    </div>
  );
}
