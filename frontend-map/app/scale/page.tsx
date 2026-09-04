'use client';

import React, { useState, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ScaleSummaryCard } from '@/components/scale/ScaleSummaryCard';
import { ScaleMap } from '@/components/scale/ScaleMap';
import { ScaleCameraList } from '@/components/scale/ScaleCameraList';
import { ScalePlayerGrid } from '@/components/scale/ScalePlayerGrid';
import { useLimitedPlayers } from '@/hooks/useLimitedPlayers';
import { useScaleMetrics } from '@/hooks/useScaleMetrics';
import { ScaleMetricsPanel } from '@/components/scale/ScaleMetricsPanel';
import { ScaleCamera } from '@/types/scaleCamera';
import { REGISTRY_API_URL } from '@/config/streams';

const MAX_CONCURRENT_PLAYERS = 4;

export default function ScaleDemoPage() {
  const [selectedById, setSelectedById] = useState<Map<number, ScaleCamera>>(new Map());
  const [backendReachable, setBackendReachable] = useState(true);
  const { activeCameraIds, openPlayer, closePlayer } = useLimitedPlayers(MAX_CONCURRENT_PLAYERS);
  const { initialLoadMs, apiRequestCount, memoryMb, recordApiRequest, recordInteraction, interactions } = useScaleMetrics();

  useEffect(() => {
    fetch(`${REGISTRY_API_URL}/health`)
      .then((res) => setBackendReachable(res.ok))
      .catch(() => setBackendReachable(false))
      .finally(() => recordApiRequest());
  }, [recordApiRequest]);

  const handleSelectCamera = (camera: ScaleCamera) => {
    setSelectedById((prev) => new Map(prev).set(camera.id, camera));
    openPlayer(camera.id);
  };

  const activeCameras = Array.from(activeCameraIds)
    .map((id) => selectedById.get(id))
    .filter((c): c is ScaleCamera => c !== undefined);

  return (
    <main className="flex-1 overflow-y-auto min-h-0 w-full p-6">
      <h1 className="text-sm font-semibold text-white uppercase tracking-wide">
        Scale Simulation — 80,000 Cameras
      </h1>
      <p className="text-xs text-slate-500 mt-1">
        Isolated synthetic control-plane demo. Live playback shown here is real, on-demand, and capped at{' '}
        {MAX_CONCURRENT_PLAYERS} concurrent streams.
      </p>

      {!backendReachable && (
        <div className="mt-3 flex items-center gap-2.5 p-3 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red text-xs">
          <AlertTriangle size={16} />
          Registry backend is unreachable — the scale demo is running in a degraded state; counts and playback below may be stale or unavailable.
        </div>
      )}

      <div className="mt-4">
        <ScaleSummaryCard />
      </div>

      <ScaleMetricsPanel
        initialLoadMs={initialLoadMs}
        apiRequestCount={apiRequestCount}
        memoryMb={memoryMb}
        interactions={interactions}
      />

      <ScalePlayerGrid cameras={activeCameras} onClose={closePlayer} />

      <div className="mt-4 h-[500px] rounded-lg overflow-hidden border border-line">
        <ScaleMap onSelectCamera={handleSelectCamera} onInteraction={recordInteraction} />
      </div>

      <div className="mt-4 h-96">
        <ScaleCameraList onSelectCamera={handleSelectCamera} />
      </div>
    </main>
  );
}
