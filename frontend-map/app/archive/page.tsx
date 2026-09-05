'use client';

import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { DistrictCircleTree, TreeSelection } from '@/components/tree/DistrictCircleTree';
import { circlesService, Circle } from '@/services/circlesService';
import { fetchRecordingSegments, RecordingSegment } from '@/services/recordingsService';
import { RecordingCalendar, toLocalDateKey } from '@/components/archive/RecordingCalendar';
import { RecordingPlayer } from '@/components/archive/RecordingPlayer';
import { Camera } from '@/types/camera';

/** Recorded-footage browsing -- separate from the live Map/Dashboard views
 * on purpose: picking a camera here means "show me what it saw," not "show
 * me what it's doing right now," and the calendar + day-scoped timeline
 * this needs would only clutter the live views. Reuses the same
 * District -> Area -> Camera tree as Map/Dashboard so navigation doesn't
 * fork into a second convention. */
function ArchivePageInner() {
  const { cameras } = useCameraRegistry();
  const searchParams = useSearchParams();

  const [treeSelection, setTreeSelection] = useState<TreeSelection>(null);
  const [circles, setCircles] = useState<Circle[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);

  const [allSegments, setAllSegments] = useState<RecordingSegment[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>(() => toLocalDateKey(new Date()));

  useEffect(() => {
    circlesService.listCircles().then(setCircles).catch(() => {
      // Non-fatal: the tree just shows no areas until this succeeds/retries.
    });
  }, []);

  const districts = useMemo(
    () => Array.from(new Set(cameras.map((cam) => cam.dept))).sort(),
    [cameras]
  );

  // A camera passed via ?camera=<id> (the CameraDetailDrawer's "Recorded
  // Footage" link) is honored once the registry has loaded, but only once --
  // an officer picking a different camera from the tree afterwards shouldn't
  // keep getting overridden back to the link's target on every render.
  const appliedInitialCamera = React.useRef(false);
  useEffect(() => {
    if (appliedInitialCamera.current || cameras.length === 0) return;
    const requestedId = searchParams.get('camera');
    if (!requestedId) return;
    const found = cameras.find((cam) => String(cam.id) === requestedId);
    if (found) {
      setSelectedCamera(found);
      appliedInitialCamera.current = true;
    }
  }, [cameras, searchParams]);

  useEffect(() => {
    if (!selectedCamera) {
      setAllSegments(null);
      return;
    }
    let cancelled = false;
    setError(null);
    fetchRecordingSegments(selectedCamera.id)
      .then((result) => {
        if (cancelled) return;
        setAvailable(result.available);
        setAllSegments(result.segments);
        if (result.segments.length > 0) {
          const mostRecent = result.segments
            .map((s) => toLocalDateKey(new Date(s.start)))
            .sort()
            .at(-1)!;
          setSelectedDate(mostRecent);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load recordings');
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCamera]);

  const daySegments = useMemo(
    () => (allSegments ?? []).filter((s) => toLocalDateKey(new Date(s.start)) === selectedDate),
    [allSegments, selectedDate]
  );

  const handleTreeSelect = (selection: TreeSelection) => {
    setTreeSelection(selection);
    if (selection?.type === 'camera') {
      const found = cameras.find((cam) => cam.id === selection.value);
      if (found) setSelectedCamera(found);
    }
  };

  return (
    <div className="flex-1 flex overflow-hidden min-h-0">
      <div className="w-72 shrink-0 border-r border-line bg-panel overflow-y-auto">
        <div className="px-3.5 py-3 border-b border-line">
          <h2 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Cameras</h2>
        </div>
        <DistrictCircleTree
          districts={districts}
          circles={circles}
          cameras={cameras}
          selected={treeSelection}
          onSelect={handleTreeSelect}
        />
      </div>

      <main className="flex-1 overflow-y-auto p-4 sm:p-6 min-h-0">
        {!selectedCamera ? (
          <div className="text-center py-16 border border-dashed border-line rounded-lg">
            <p className="text-slate-400 text-sm">Pick a camera from the tree to browse its recorded footage.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <h1 className="text-sm font-semibold text-white tracking-wide">
              Archive — {selectedCamera.name}
            </h1>

            {error && <p className="text-xs text-signal-red">{error}</p>}

            {!error && allSegments === null && <p className="text-xs text-slate-500">Loading recordings…</p>}

            {!error && allSegments !== null && (!available || allSegments.length === 0) && (
              <p className="text-xs text-slate-500">
                No recorded footage available for this camera yet. Recording starts once the camera has been viewed live.
              </p>
            )}

            {allSegments !== null && available && allSegments.length > 0 && (
              <div className="flex flex-col sm:flex-row gap-6">
                <RecordingCalendar
                  segments={allSegments}
                  selectedDate={selectedDate}
                  onSelectDate={setSelectedDate}
                />
                <div className="flex-1 min-w-0">
                  <RecordingPlayer
                    pathId={selectedCamera.stream_id || selectedCamera.id}
                    cameraName={selectedCamera.name}
                    segments={daySegments}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default function ArchivePage() {
  return (
    <Suspense fallback={null}>
      <ArchivePageInner />
    </Suspense>
  );
}
