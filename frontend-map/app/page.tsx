'use client';

import React, { useEffect, useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCameraRegistry } from '../context/CameraRegistryContext';
import CameraDetailDrawer from '../components/registry/CameraDetailDrawer';
import CameraFilterBar from '../components/registry/CameraFilterBar';
import CameraListSkeleton from '../components/registry/CameraListSkeleton';
import VirtualizedCameraList from '../components/registry/VirtualizedCameraList';
import AddCameraModal from '../components/registry/AddCameraModal';
import { Shield, RefreshCw, LogOut, AlertTriangle, Search, Plus, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

const CameraMap = dynamic(() => import('../components/map/CameraMap'), {
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

// Isolated so the once-a-second tick only re-renders this small readout, not
// the whole dashboard (map, video, virtualized list) — a live clock is a
// control-room staple, but it must not be the thing that costs frame budget.
function LiveClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!now) return <span className="font-mono text-slate-500 w-[70px] inline-block" />;

  return (
    <span className="font-mono text-slate-400 tabular-nums">
      {now.toLocaleTimeString('en-IN', { hour12: false })} IST
    </span>
  );
}

function StatusTicker() {
  const { cameras } = useCameraRegistry();
  const counts = useMemo(() => {
    let online = 0;
    let offline = 0;
    for (const cam of cameras) {
      if ((cam.connectivity_status || 'offline').toLowerCase() === 'online') online++;
      else offline++;
    }
    return { online, offline };
  }, [cameras]);

  return (
    <div className="flex items-center gap-3 font-mono">
      <span className="flex items-center gap-1.5 text-slate-400">
        <span className="w-1.5 h-1.5 rounded-full bg-signal-green" />
        {counts.online} ONLINE
      </span>
      <span className="flex items-center gap-1.5 text-slate-500">
        <span className="w-1.5 h-1.5 rounded-full bg-signal-red" />
        {counts.offline} OFFLINE
      </span>
    </div>
  );
}

function MainDashboard() {
  const router = useRouter();
  const {
    filteredCameras,
    selectedCamera,
    setSelectedCamera,
    refreshCameras,
    isLoading,
    error,
  } = useCameraRegistry();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showAddCamera, setShowAddCamera] = useState(false);

  const handleLogout = () => {
    localStorage.removeItem('netra_authenticated');
    router.push('/login');
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-ink text-slate-100 overflow-hidden">
      <header className="h-14 border-b border-line px-4 sm:px-6 flex items-center justify-between bg-panel shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            aria-label={sidebarOpen ? 'Collapse camera list' : 'Expand camera list'}
            onClick={() => setSidebarOpen((v) => !v)}
            className="text-slate-400 hover:text-white p-1.5 rounded hover:bg-panel-raised shrink-0"
          >
            {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
          <Shield className="text-command shrink-0" size={20} />
          <h1 className="font-bold text-sm tracking-wider uppercase text-white truncate">NETRA Command</h1>
        </div>
        <div className="flex items-center gap-4 text-xs shrink-0">
          <LiveClock />
          <div className="hidden md:block h-4 w-px bg-line" />
          <div className="hidden md:block">
            <StatusTicker />
          </div>
          <div className="hidden lg:block h-4 w-px bg-line" />
          <button
            onClick={() => setShowAddCamera(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-slate-300 hover:text-white bg-panel-raised rounded border border-line"
          >
            <Plus size={13} />
            <span className="hidden sm:inline">Add Camera</span>
          </button>
          <button
            onClick={() => router.push('/search')}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-slate-300 hover:text-white bg-panel-raised rounded border border-line"
          >
            <Search size={13} />
            <span className="hidden sm:inline">Vehicle Search</span>
          </button>
          <button
            onClick={() => refreshCameras()}
            aria-label="Refresh camera registry"
            className="p-1.5 text-slate-400 hover:text-white bg-panel-raised rounded border border-line"
          >
            <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={handleLogout}
            aria-label="Log out"
            className="p-1.5 text-slate-400 hover:text-signal-red bg-panel-raised rounded border border-line"
          >
            <LogOut size={14} />
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden relative">
        <aside
          className={`shrink-0 h-full flex flex-col bg-panel border-r border-line overflow-hidden transition-[width] duration-200 ${
            sidebarOpen ? 'w-80' : 'w-0 border-r-0'
          }`}
        >
          <div className="w-80 h-full flex flex-col">
            <div className="px-3.5 py-3 border-b border-line flex items-center justify-between">
              <h2 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
                {isLoading ? 'Syncing feeds…' : `${filteredCameras.length} Feeds`}
              </h2>
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
              <VirtualizedCameraList
                cameras={filteredCameras}
                selectedCamera={selectedCamera}
                onSelect={setSelectedCamera}
              />
            )}
          </div>
        </aside>

        <section className="flex-1 flex flex-col h-full overflow-hidden">
          <div className="flex-1 relative">
            <CameraMap
              cameras={filteredCameras}
              selectedCamera={selectedCamera}
              onSelectCamera={setSelectedCamera}
            />
          </div>
          <CameraDetailDrawer camera={selectedCamera} />
        </section>
      </div>

      {showAddCamera && <AddCameraModal onClose={() => setShowAddCamera(false)} />}
    </div>
  );
}

export default function Page() {
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

  // CameraRegistryProvider already wraps the whole app in app/layout.tsx —
  // nesting a second instance here used to spin up a fresh fetch (and lose
  // filter/selection state) on every navigation to/from this route.
  return <MainDashboard />;
}
