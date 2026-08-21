'use client';

import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { CameraRegistryProvider, useCameraRegistry } from '../context/CameraRegistryContext';
import CameraCard from '../components/registry/CameraCard';
import CameraDetailDrawer from '../components/registry/CameraDetailDrawer';
import { Shield, RefreshCw, LogOut } from 'lucide-react';

const CameraMap = dynamic(() => import('../components/map/CameraMap'), { ssr: false });

function MainDashboard() {
  const router = useRouter();
  const {
    filteredCameras,
    selectedCamera,
    setSelectedCamera,
    refreshCameras,
    isLoading,
  } = useCameraRegistry();

  const handleLogout = () => {
    localStorage.removeItem('netra_authenticated');
    router.push('/login');
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden">
      <header className="h-14 border-b border-slate-800 px-6 flex items-center justify-between bg-slate-900/80 shrink-0">
        <div className="flex items-center gap-3">
          <Shield className="text-blue-500" size={22} />
          <div>
            <h1 className="font-bold text-sm tracking-wider uppercase text-white">NETRA GIS Registry</h1>
            <p className="text-[10px] text-slate-400">Phase 0 Standalone Viewer</p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className="text-slate-400">
            Total Feeds: <strong className="text-white">{filteredCameras.length}</strong>
          </span>
          <button
            onClick={() => refreshCameras()}
            className="p-1.5 text-slate-400 hover:text-white bg-slate-800 rounded border border-slate-700"
          >
            <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={handleLogout}
            className="p-1.5 text-slate-400 hover:text-red-400 bg-slate-800 rounded border border-slate-700"
          >
            <LogOut size={14} />
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <aside className="w-80 shrink-0 h-full flex flex-col bg-slate-900 border-r border-slate-800 overflow-y-auto">
          {filteredCameras.map((cam) => (
            <CameraCard
              key={cam.id}
              camera={cam}
              isSelected={selectedCamera?.id === cam.id}
              onSelect={() => setSelectedCamera(cam)}
            />
          ))}
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

  return (
    <CameraRegistryProvider>
      <MainDashboard />
    </CameraRegistryProvider>
  );
}