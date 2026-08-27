'use client';

import React, { useState } from 'react';
import dynamic from 'next/dynamic';
import { Camera } from '@/types/camera';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { CameraFilterBar } from '@/components/registry/CameraFilterBar';
import CameraCard from '@/components/registry/CameraCard';
import CameraDetailDrawer from '@/components/registry/CameraDetailDrawer';
import CameraListSkeleton from '@/components/registry/CameraListSkeleton';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

const CameraMap = dynamic(
  () => import('@/components/map/CameraMap').then((mod) => mod.CameraMap || mod.default),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex items-center justify-center bg-slate-950 text-slate-400 text-sm">
        <div className="flex flex-col items-center gap-2">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <span>Loading Gujarat GIS Map Engine...</span>
        </div>
      </div>
    ),
  }
);

export default function MapDashboardPage() {
  const { filteredCameras, selectedCamera, setSelectedCamera, isLoading, error } =
    useCameraRegistry();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className="relative flex h-screen w-screen bg-slate-950 overflow-hidden">
      {/* Responsive Collapsible Sidebar */}
      <aside
        className={`absolute md:relative z-20 h-full w-80 md:w-96 bg-slate-900 border-r border-slate-800 flex flex-col transition-transform duration-300 ease-in-out ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full md:-translate-x-full'
        }`}
      >
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h1 className="text-sm font-bold tracking-wider text-slate-100 uppercase">
              Camera Registry
            </h1>
            <p className="text-[11px] text-slate-400">
              {isLoading ? 'Syncing feeds...' : `${filteredCameras.length} Feeds Available`}
            </p>
          </div>
          <button
            type="button"
            aria-label="Toggle sidebar"
            onClick={() => setSidebarOpen(false)}
            className="text-slate-400 hover:text-slate-200 p-1 rounded hover:bg-slate-800 md:hidden"
          >
            <PanelLeftClose className="h-5 w-5" />
          </button>
        </div>

        {/* Filter Controls */}
        <CameraFilterBar />

        {/* Camera Feed List */}
        <div className="flex-1 overflow-y-auto divide-y divide-slate-800/50">
          {isLoading ? (
            <CameraListSkeleton />
          ) : error ? (
            <div className="p-4 text-center text-xs text-red-400">
              Failed to load registry: {error}
            </div>
          ) : filteredCameras.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500">
              No matching cameras found for active filters.
            </div>
          ) : (
            filteredCameras.map((cam: Camera) => (
              <CameraCard
                key={cam.id}
                camera={cam}
                isSelected={selectedCamera?.id === cam.id}
                onSelect={() => setSelectedCamera(cam)}
              />
            ))
          )}
        </div>
      </aside>

      {/* Floating Sidebar Toggle Button */}
      {!sidebarOpen && (
        <button
          type="button"
          aria-label="Open sidebar"
          onClick={() => setSidebarOpen(true)}
          className="absolute top-4 left-4 z-30 bg-slate-900/90 backdrop-blur border border-slate-700 text-slate-200 p-2 rounded-md shadow-lg hover:bg-slate-800 transition"
        >
          <PanelLeftOpen className="h-5 w-5" />
        </button>
      )}

      {/* Main Map Engine */}
      <main className="flex-1 h-full w-full relative z-10">
        <CameraMap
          cameras={filteredCameras}
          selectedCamera={selectedCamera}
          onSelectCamera={(cam: Camera) => setSelectedCamera(cam)}
        />
      </main>

      {/* Camera Detail Drawer */}
      {selectedCamera && (
        <CameraDetailDrawer camera={selectedCamera} />
      )}
    </div>
  );
}