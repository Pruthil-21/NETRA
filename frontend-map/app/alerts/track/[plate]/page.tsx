'use client';

import React, { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { useGeolocation } from '@/lib/geolocation';
import { resolveSightingCamera } from '@/lib/resolveSightingCamera';
import { detectionService } from '@/services/detectionService';
import { Detection } from '@/types/detection';

const POLL_INTERVAL_MS = 5000;

const LiveRouteMap = dynamic(() => import('@/components/map/LiveRouteMap').then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-ink text-slate-500 text-xs">
      LOADING MAP…
    </div>
  ),
});

/** Live route from the officer's own current location to wherever this
 * plate was *last* detected. Re-polls detections so if a newer sighting
 * lands at a different camera while this page is open, the destination
 * updates to follow it -- same "keep alerting, update checkpoint" idea
 * as the vehicle-search feature, but starting from an alert instead of a
 * manual search. */
export default function TrackPlatePage() {
  const params = useParams<{ plate: string }>();
  const router = useRouter();
  const plate = decodeURIComponent(params.plate);
  const { cameras } = useCameraRegistry();
  const geo = useGeolocation(true);
  const [latest, setLatest] = useState<Detection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const camerasById = useMemo(() => new Map(cameras.map((c) => [c.id, c])), [cameras]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const sightings = await detectionService.search({ plate_number: plate });
        if (cancelled || sightings.length === 0) return;
        const newest = [...sightings].sort(
          (a, b) => new Date(b.detected_at).getTime() - new Date(a.detected_at).getTime()
        )[0];
        setLatest((prev) =>
          !prev || new Date(newest.detected_at).getTime() > new Date(prev.detected_at).getTime() ? newest : prev
        );
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load sightings');
      }
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [plate]);

  const destinationCamera = latest ? resolveSightingCamera(latest, camerasById) : null;

  return (
    <main className="flex-1 flex flex-col overflow-hidden min-h-0 w-full">
      <div className="h-11 border-b border-line px-4 flex items-center gap-3 bg-panel shrink-0">
        <button
          type="button"
          aria-label="Back to alerts"
          onClick={() => router.back()}
          className="text-slate-400 hover:text-white p-1 rounded hover:bg-panel-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
        >
          <ArrowLeft size={15} />
        </button>
        <h1 className="text-xs font-semibold tracking-wide text-slate-300 uppercase truncate">
          Tracking <span className="font-mono text-command">{plate}</span>
        </h1>
      </div>

      <div className="flex-1 relative">
        {geo.status === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-xs">
            Detecting your current location…
          </div>
        )}
        {geo.status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center text-signal-red text-xs px-6 text-center">
            Can&apos;t get your location: {geo.message}. Live routing needs location permission.
          </div>
        )}
        {geo.status === 'ready' && !destinationCamera && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-xs px-6 text-center">
            {error || `No sightings for ${plate} yet.`}
          </div>
        )}
        {geo.status === 'ready' && destinationCamera && (
          <LiveRouteMap
            officerPosition={geo.position}
            destination={{ name: destinationCamera.name, lat: destinationCamera.lat, long: destinationCamera.long }}
          />
        )}

        {destinationCamera && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] px-3 py-1.5 rounded bg-panel/90 border border-blue-500/40 shadow-lg text-center pointer-events-none">
            <p className="text-[11px] font-semibold tracking-wide text-blue-300 uppercase">
              Live route to last sighting — {destinationCamera.name}
            </p>
            <p className="text-[10px] text-slate-400">
              Updates automatically if a newer sighting lands at a different camera
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
