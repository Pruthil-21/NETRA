'use client';

import React, { useState } from 'react';
import { Plus, RefreshCw, AlertTriangle, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useCameraRegistry, HEALTH_CHECK_INTERVAL_MS } from '@/context/CameraRegistryContext';
import { usePermissions } from '@/hooks/usePermissions';
import { StaleIndicator } from '@/components/common/StaleIndicator';
import CameraListSkeleton from '@/components/registry/CameraListSkeleton';
import AddCameraModal from '@/components/registry/AddCameraModal';
import { DistrictCircleTree, TreeSelection } from '@/components/tree/DistrictCircleTree';
import { Circle } from '@/services/circlesService';
import { Camera } from '@/types/camera';

interface CameraRegistrySidebarProps {
  districts: string[];
  circles: Circle[];
  cameras: Camera[];
  selected: TreeSelection;
  onSelect: (selection: TreeSelection) => void;
  homeDistrict?: string | null;
}

/** The one Camera Registry sidebar -- header (live count, Add Camera,
 * Refresh, collapse) plus the District -> Area -> Camera tree. Byte-identical
 * across Dashboard, Map, and Archive so the three stop drifting into three
 * separately hand-built wrappers around the same tree (each with its own
 * width, its own subset of buttons, its own loading/error handling). Reads
 * registry loading/error/refresh state straight from CameraRegistryContext --
 * the same context instance every page already shares -- rather than taking
 * it as props, so callers only need to supply the tree's own data. Renders
 * into an ancestor expected to be `relative`-positioned, for the floating
 * expand toggle shown while collapsed. */
export function CameraRegistrySidebar({
  districts,
  circles,
  cameras,
  selected,
  onSelect,
  homeDistrict,
}: CameraRegistrySidebarProps) {
  const { isLoading, error, lastUpdated, refreshCameras } = useCameraRegistry();
  const { has } = usePermissions();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showAddCamera, setShowAddCamera] = useState(false);

  return (
    <>
      <aside
        className={`shrink-0 h-full flex flex-col bg-panel border-r border-line overflow-hidden transition-[width] duration-200 ${
          sidebarOpen ? 'w-72' : 'w-0 border-r-0'
        }`}
      >
        <div className="w-72 h-full flex flex-col">
          <div className="px-3.5 py-3 border-b border-line flex items-center justify-between gap-2">
            <div className={`min-w-0 ${isLoading ? 'opacity-60 transition-opacity' : 'transition-opacity'}`}>
              <h2 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase truncate">
                {isLoading ? 'Syncing feeds…' : `${cameras.length} Feeds`}
              </h2>
              {!isLoading && (
                <StaleIndicator lastUpdated={lastUpdated} hasError={!!error} pollIntervalMs={HEALTH_CHECK_INTERVAL_MS} />
              )}
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
          ) : (
            <div className="flex-1 min-h-0 flex flex-col">
              <DistrictCircleTree
                districts={districts}
                circles={circles}
                cameras={cameras}
                selected={selected}
                onSelect={onSelect}
                homeDistrict={homeDistrict}
                defaultCollapsed
              />
            </div>
          )}
        </div>
      </aside>

      {!sidebarOpen && (
        // Vertically centered on the left edge, deliberately clear of any
        // top-left overlay controls (e.g. the map's zoom buttons) and bottom
        // panels (e.g. a detail drawer) -- both can live in the same
        // `relative` ancestor this floats against.
        <button
          type="button"
          aria-label="Expand camera list"
          onClick={() => setSidebarOpen(true)}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-[500] p-1.5 rounded bg-panel-raised border border-line text-slate-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
        >
          <PanelLeftOpen size={16} />
        </button>
      )}

      {showAddCamera && <AddCameraModal onClose={() => setShowAddCamera(false)} />}
    </>
  );
}

export default CameraRegistrySidebar;
