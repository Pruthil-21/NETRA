'use client';

import React, { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useCameraRegistry, HEALTH_CHECK_INTERVAL_MS } from '@/context/CameraRegistryContext';
import CameraDetailDrawer from '@/components/registry/CameraDetailDrawer';
import CameraFilterBar from '@/components/registry/CameraFilterBar';
import CameraListSkeleton from '@/components/registry/CameraListSkeleton';
import VirtualizedCameraList from '@/components/registry/VirtualizedCameraList';
import AddCameraModal from '@/components/registry/AddCameraModal';
import { StaleIndicator, useStaleness } from '@/components/common/StaleIndicator';
import { RefreshCw, AlertTriangle, Plus, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { usePermissions } from '@/hooks/usePermissions';
import { DistrictCircleTree, TreeSelection } from '@/components/tree/DistrictCircleTree';
import { CameraInfoOverlay } from '@/components/overlay/CameraInfoOverlay';
import { circlesService, Circle } from '@/services/circlesService';

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
 * only what's specific to it: the sidebar toggle, filters, and Add Camera. */
export default function MapPage() {
  const {
    cameras,
    filteredCameras,
    selectedCamera,
    setSelectedCamera,
    refreshCameras,
    isLoading,
    error,
    lastUpdated,
  } = useCameraRegistry();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showAddCamera, setShowAddCamera] = useState(false);
  const { isStale } = useStaleness(lastUpdated, !!error, HEALTH_CHECK_INTERVAL_MS);
  const { has } = usePermissions();

  const [treeSelection, setTreeSelection] = useState<TreeSelection>(null);
  const [circles, setCircles] = useState<Circle[]>([]);
  const [hoveredCameraId, setHoveredCameraId] = useState<number | null>(null);

  useEffect(() => {
    circlesService.listCircles().then(setCircles).catch(() => {
      // Non-fatal: the tree just shows no circles until this succeeds/retries.
    });
  }, []);

  // Tree structure (districts/circles) always reflects the full registry, not
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
    const matches =
      treeSelection.type === 'district'
        ? filteredCameras.filter((cam) => cam.dept === treeSelection.value)
        : filteredCameras.filter((cam) => cam.circle_id === treeSelection.value);
    return new Set(matches.map((cam) => cam.id));
  }, [treeSelection, filteredCameras]);

  const hoveredCamera = useMemo(
    () => (hoveredCameraId != null ? cameras.find((cam) => cam.id === hoveredCameraId) ?? null : null),
    [cameras, hoveredCameraId]
  );
  const hoveredCircleName = useMemo(
    () => circles.find((circle) => circle.id === hoveredCamera?.circle_id)?.name ?? null,
    [circles, hoveredCamera]
  );

  return (
    <div className="flex-1 flex overflow-hidden relative min-h-0">
      <aside
        className={`shrink-0 h-full flex flex-col bg-panel border-r border-line overflow-hidden transition-[width] duration-200 ${
          sidebarOpen ? 'w-80' : 'w-0 border-r-0'
        }`}
      >
        <div className="w-80 h-full flex flex-col">
          <div className="px-3.5 py-3 border-b border-line flex items-center justify-between gap-2">
            <div className={`min-w-0 ${isStale ? 'opacity-60 transition-opacity' : 'transition-opacity'}`}>
              <h2 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase truncate">
                {isLoading ? 'Syncing feeds…' : `${filteredCameras.length} Feeds`}
              </h2>
              {!isLoading && <StaleIndicator lastUpdated={lastUpdated} hasError={!!error} pollIntervalMs={HEALTH_CHECK_INTERVAL_MS} />}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {has('manage_cameras') && (
                <button
                  type="button"
                  onClick={() => setShowAddCamera(true)}
                  aria-label="Add camera"
                  className="p-1.5 text-slate-400 hover:text-white bg-panel-raised rounded border border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                >
                  <Plus size={13} />
                </button>
              )}
              <button
                type="button"
                onClick={() => refreshCameras()}
                aria-label="Refresh camera registry"
                className="p-1.5 text-slate-400 hover:text-white bg-panel-raised rounded border border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
              >
                <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
              </button>
              <button
                type="button"
                aria-label="Collapse camera list"
                onClick={() => setSidebarOpen(false)}
                className="p-1.5 text-slate-400 hover:text-white bg-panel-raised rounded border border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
              >
                <PanelLeftClose size={13} />
              </button>
            </div>
          </div>
          <CameraFilterBar />
          {error ? (
            <div className="flex flex-col items-center text-center gap-2 p-6 text-signal-red">
              <AlertTriangle size={20} />
              <p className="text-xs font-semibold">Failed to load camera registry</p>
              <p className="text-[11px] text-slate-500">{error}</p>
              <button
                onClick={() => refreshCameras()}
                className="mt-1 text-[11px] px-2.5 py-1 rounded bg-panel-raised border border-line text-slate-200 hover:text-white"
              >
                Retry
              </button>
            </div>
          ) : isLoading ? (
            <CameraListSkeleton />
          ) : filteredCameras.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500">No cameras match the active filters.</div>
          ) : (
            <div className={`flex-1 min-h-0 flex flex-col ${isStale ? 'opacity-60 transition-opacity' : 'transition-opacity'}`}>
              <VirtualizedCameraList
                cameras={filteredCameras}
                selectedCamera={selectedCamera}
                onSelect={setSelectedCamera}
              />
            </div>
          )}
        </div>
      </aside>

      {!sidebarOpen && (
        // Vertically centered on the map's left edge, deliberately clear of
        // Leaflet's own zoom control (top-left corner) and the detail drawer
        // (bottom) -- both live in this same map pane.
        <button
          type="button"
          aria-label="Expand camera list"
          onClick={() => setSidebarOpen(true)}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-[500] p-1.5 rounded bg-panel-raised border border-line text-slate-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
        >
          <PanelLeftOpen size={16} />
        </button>
      )}

      <main className="flex-1 flex flex-col h-full overflow-hidden">
        <div className="flex-1 flex overflow-hidden min-h-0">
          <DistrictCircleTree
            districts={districts}
            circles={circles}
            selected={treeSelection}
            onSelect={setTreeSelection}
          />
          <div className="flex-1 relative">
            <CameraMap
              cameras={filteredCameras}
              selectedCamera={selectedCamera}
              onSelectCamera={setSelectedCamera}
              onHoverChange={setHoveredCameraId}
              highlightedCameraIds={highlightedCameraIds}
            />
          </div>
        </div>
        <CameraDetailDrawer camera={selectedCamera} />
      </main>

      {showAddCamera && <AddCameraModal onClose={() => setShowAddCamera(false)} />}

      <CameraInfoOverlay
        camera={hoveredCamera}
        circleName={hoveredCircleName}
        onClose={() => setHoveredCameraId(null)}
      />
    </div>
  );
}
