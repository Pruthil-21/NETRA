'use client';

import React, { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { VehicleSearchPanel } from '@/components/search/VehicleSearchPanel';
import { SightingAlertToasts } from '@/components/search/SightingAlertToasts';
import TrajectoryTimeline from '@/components/search/TrajectoryTimeline';
import CameraDetailDrawer from '@/components/registry/CameraDetailDrawer';
import { Camera } from '@/types/camera';
import { Detection, PredictedNextCamera } from '@/types/detection';
import { buildSightingRoute } from '@/lib/buildSightingRoute';
import { detectionService } from '@/services/detectionService';

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
 * on-demand (a lead comes in), unlike the Dashboard's continuous
 * monitoring. Nav/auth/header live in the shared AppShell. */
export default function VehicleSearchPage() {
  const { cameras, isLoading, error } = useCameraRegistry();
  const searchParams = useSearchParams();
  const initialPlate = searchParams.get('plate') ?? undefined;
  const [sightings, setSightings] = useState<Detection[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);

  // Same chronological, camera-resolved list CameraMap draws its route from
  // (see lib/buildSightingRoute.ts) -- shared so the timeline's stop N is
  // always CameraMap's point N.
  const resolvedRoute = useMemo(() => buildSightingRoute(sightings, cameras), [sightings, cameras]);
  const [timelineIndex, setTimelineIndex] = useState(0);

  // A fresh search (or a poll landing a new sighting) jumps the scrubber to
  // the most recent stop -- the "where is it now" default -- rather than
  // resetting mid-scrub every 5s while the background poll in
  // VehicleSearchPanel is merely re-confirming the same result set.
  useEffect(() => {
    setTimelineIndex(resolvedRoute.length === 0 ? 0 : resolvedRoute.length - 1);
    // Only re-runs when the count of resolved sightings actually changes
    // (new search, or a poll landing a genuinely new sighting) -- an
    // unchanged-result poll tick doesn't touch resolvedRoute.length, so it
    // never yanks the scrubber away from wherever the user left it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedRoute.length]);

  const [predictedNext, setPredictedNext] = useState<PredictedNextCamera[]>([]);
  const lastCameraId = resolvedRoute.length > 0 ? resolvedRoute[resolvedRoute.length - 1].camera.id : null;

  // Predicted-next is only meaningful from the plate's actual current
  // position (the LAST resolved stop's camera) -- keyed on that camera id
  // alone, so it doesn't refetch on every poll tick unless the plate has
  // genuinely moved to a new camera since the last check.
  useEffect(() => {
    if (lastCameraId == null) {
      setPredictedNext([]);
      return;
    }
    let cancelled = false;
    detectionService.predictNextCamera(lastCameraId).then((candidates) => {
      if (!cancelled) setPredictedNext(candidates);
    });
    return () => {
      cancelled = true;
    };
  }, [lastCameraId]);

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
              initialPlate={initialPlate}
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
            timelineIndex={resolvedRoute.length > 1 ? timelineIndex : undefined}
          />
          <SightingAlertToasts sightings={sightings} cameras={cameras} />
          {resolvedRoute.length > 1 && (
            <TrajectoryTimeline
              resolved={resolvedRoute}
              currentIndex={timelineIndex}
              onIndexChange={setTimelineIndex}
              predictedNext={predictedNext}
            />
          )}
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
