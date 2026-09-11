'use client';

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { TreeSelection } from '@/components/tree/DistrictAreaTree';
import { CameraRegistrySidebar } from '@/components/registry/CameraRegistrySidebar';
import { areasService, Area } from '@/services/areasService';
import { fetchRecordingSegments, RecordingSegment } from '@/services/recordingsService';
import { RecordingCalendar, toLocalDateKey } from '@/components/archive/RecordingCalendar';
import { RecordingPlayer } from '@/components/archive/RecordingPlayer';
import { ArchiveGridTile } from '@/components/archive/ArchiveGridTile';
import { Camera } from '@/types/camera';
import { usePermissions } from '@/hooks/usePermissions';
import { useCameraDropTarget } from '@/hooks/useCameraDropTarget';

const MAX_ARCHIVE_GRID_CAMERAS = 6;

/** Recorded-footage browsing -- separate from the live Map/Dashboard views
 * on purpose: picking a camera here means "show me what it saw," not "show
 * me what it's doing right now," and the calendar + day-scoped timeline
 * this needs would only clutter the live views. Reuses the same
 * District -> Area -> Camera tree as Map/Dashboard so navigation doesn't
 * fork into a second convention. */
function ArchivePageInner() {
  const { cameras } = useCameraRegistry();
  const { scopeValue: homeDistrict } = usePermissions();
  const searchParams = useSearchParams();

  const [treeSelection, setTreeSelection] = useState<TreeSelection>(null);
  const [areas, setAreas] = useState<Area[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);

  const [allSegments, setAllSegments] = useState<RecordingSegment[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>(() => toLocalDateKey(new Date()));
  // Freshly fetched for whichever day is selected, separately from
  // allSegments -- each segment's playback url only carries a 15-minute
  // token, so the broad history fetch below (which only exists to feed the
  // calendar's "which days have anything" dots) can't double as this.
  const [daySegments, setDaySegments] = useState<RecordingSegment[] | null>(null);
  const [dayError, setDayError] = useState<string | null>(null);

  // Cameras dragged in from the sidebar to browse side by side -- takes over
  // the whole main panel ahead of the single-camera calendar+player view
  // below (same "drag is a deliberate, explicit pick" precedent as the
  // Dashboard's watch set, just recorded footage instead of live streams).
  const [gridCameraIds, setGridCameraIds] = useState<Set<number>>(new Set());
  const [gridNotice, setGridNotice] = useState<string | null>(null);
  const isGridMode = gridCameraIds.size > 0;

  const handleDropCameraIds = useCallback((cameraIds: number[]) => {
    setGridCameraIds((prev) => {
      const next = new Set(prev);
      let dropped = 0;
      for (const id of cameraIds) {
        if (next.has(id)) continue;
        if (next.size >= MAX_ARCHIVE_GRID_CAMERAS) {
          dropped += 1;
          continue;
        }
        next.add(id);
      }
      if (dropped > 0) {
        setGridNotice(
          `Only added ${MAX_ARCHIVE_GRID_CAMERAS - prev.size} of ${cameraIds.length} cameras — ${MAX_ARCHIVE_GRID_CAMERAS} at once is the limit here.`
        );
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!gridNotice) return;
    const timer = setTimeout(() => setGridNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [gridNotice]);

  const handleRemoveFromGrid = useCallback((cameraId: number) => {
    setGridCameraIds((prev) => {
      const next = new Set(prev);
      next.delete(cameraId);
      return next;
    });
  }, []);

  const gridCameras = useMemo(
    () => cameras.filter((c) => gridCameraIds.has(c.id)),
    [cameras, gridCameraIds]
  );
  const gridCols = Math.max(1, Math.ceil(Math.sqrt(gridCameraIds.size)));
  const { isOver: isGridDropTarget, dropHandlers: gridDropHandlers } = useCameraDropTarget(handleDropCameraIds);

  useEffect(() => {
    areasService.listAreas().then(setAreas).catch(() => {
      // Non-fatal: the tree just shows no areas until this succeeds/retries.
    });
  }, []);

  const districts = useMemo(
    () => Array.from(new Set(cameras.map((cam) => cam.dept))).sort(),
    [cameras]
  );

// A camera passed via ?camera=<id> (the CameraDetailDrawer's "Recorded
  // Footage" link, or an alert's "View Footage" link) is honored once per
  // distinct id -- tracked by the id itself, not a one-time-ever boolean,
  // so a *second* "View Footage" click for a *different* alert (a fresh
  // navigation to this same already-mounted page, just with a new
  // ?camera=) still takes effect instead of being silently ignored because
  // "a deep link was already applied once." Still only reacts to the URL
  // param actually changing, never to `cameras` itself refreshing in the
  // background, so an officer's own manual tree pick afterwards isn't
  // fought on the next unrelated poll.
  const requestedCameraId = searchParams.get('camera');
  const lastAppliedCameraId = useRef<string | null>(null);
  useEffect(() => {
    if (!requestedCameraId || cameras.length === 0 || lastAppliedCameraId.current === requestedCameraId) return;
    const found = cameras.find((cam) => String(cam.id) === requestedCameraId);
    if (found) {
      setSelectedCamera(found);
      lastAppliedCameraId.current = requestedCameraId;
    }
  }, [cameras, requestedCameraId]);

  // ?at=<ISO timestamp> (an alert's "View Footage" link) -- jump straight to
  // roughly 10 seconds before that exact moment, on that moment's own
  // calendar day, rather than wherever the segments effect below would
  // otherwise default to (the most recent day with footage). Same
  // by-value tracking as the camera id above: a second "View Footage"
  // click for a different alert -- even one on the *same* camera, so the
  // effect below wouldn't otherwise re-run at all -- still lands on its
  // own moment instead of being stuck on the first one this page instance
  // ever saw. seekTargetIso itself is cleared once RecordingPlayer
  // confirms it actually applied the seek, so a day the officer picks
  // manually afterwards is never silently overridden back to it.
  const requestedAt = searchParams.get('at');
  const lastAppliedAt = useRef<string | null>(null);
  const [seekTargetIso, setSeekTargetIso] = useState<string | null>(null);
  useEffect(() => {
    if (!requestedAt || lastAppliedAt.current === requestedAt) return;
    setSelectedDate(toLocalDateKey(new Date(requestedAt)));
    setSeekTargetIso(new Date(new Date(requestedAt).getTime() - 10000).toISOString());
    lastAppliedAt.current = requestedAt;
  }, [requestedAt]);

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
        // A deep-linked moment (?at=) picks its own calendar day via the
        // effect above, which runs independently of this fetch -- only
        // fall back to "most recent day with any footage" when there's no
        // such moment to defer to at all.
        if (result.segments.length > 0 && !requestedAt) {
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

  // Re-fetched (fresh tokens) every time the selected camera or day
  // changes -- reusing allSegments' entries here would mean playing back
  // with a token that may well have gone stale by the time the officer
  // actually clicks play.
  useEffect(() => {
    if (!selectedCamera) {
      setDaySegments(null);
      return;
    }
    let cancelled = false;
    setDayError(null);
    setDaySegments(null);
    const dayStart = new Date(`${selectedDate}T00:00:00`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    fetchRecordingSegments(selectedCamera.id, { start: dayStart.toISOString(), end: dayEnd.toISOString() })
      .then((result) => {
        if (!cancelled) setDaySegments(result.segments);
      })
      .catch((err) => {
        if (!cancelled) setDayError(err instanceof Error ? err.message : 'Failed to load recordings for this day');
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCamera, selectedDate]);

  const handleTreeSelect = (selection: TreeSelection) => {
    setTreeSelection(selection);
    if (selection?.type === 'camera') {
      const found = cameras.find((cam) => cam.id === selection.value);
      if (found) setSelectedCamera(found);
    }
  };

  return (
    <div className="flex-1 flex overflow-hidden min-h-0 relative">
      <CameraRegistrySidebar
        districts={districts}
        areas={areas}
        cameras={cameras}
        selected={treeSelection}
        onSelect={handleTreeSelect}
        homeDistrict={homeDistrict}
      />

      <main
        {...gridDropHandlers}
        className={`flex-1 overflow-y-auto p-4 sm:p-6 min-h-0 rounded-lg transition-shadow ${
          isGridDropTarget ? 'ring-2 ring-command ring-offset-2 ring-offset-ink' : ''
        }`}
      >
        {isGridMode ? (
          <div className="flex flex-col gap-4 h-full">
            <div className="flex items-center justify-between gap-3">
              <h1 className="text-sm font-semibold text-white tracking-wide">
                Archive — {gridCameraIds.size} camera{gridCameraIds.size === 1 ? '' : 's'}
              </h1>
              <button
                type="button"
                onClick={() => setGridCameraIds(new Set())}
                className="text-xs text-command hover:underline font-semibold shrink-0"
              >
                Exit grid view
              </button>
            </div>
            {gridNotice && (
              <div className="text-xs bg-amber-950/60 border border-amber-800 text-amber-300 rounded-lg px-3 py-2">
                {gridNotice}
              </div>
            )}
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}
            >
              {gridCameras.map((camera) => (
                <ArchiveGridTile key={camera.id} camera={camera} onRemove={handleRemoveFromGrid} />
              ))}
            </div>
          </div>
        ) : !selectedCamera ? (
          <div className="text-center py-16 border border-dashed border-line rounded-lg">
            <p className="text-slate-400 text-sm">
              Pick a camera from the tree to browse its recorded footage, or drag a camera, area, or district here to
              compare several at once.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <h1 className="text-sm font-semibold text-white tracking-wide">
              Archive — {selectedCamera.name}
            </h1>

            {error && <p className="text-xs text-signal-red">{error}</p>}

            {!error && allSegments === null && <p className="text-xs text-slate-500">Loading recordings…</p>}

            {!error && allSegments !== null && (!available || allSegments.length === 0) && (
              <p className="text-xs text-slate-500">No recorded footage available for this camera yet.</p>
            )}

            {allSegments !== null && available && allSegments.length > 0 && (
              <div className="flex flex-col sm:flex-row gap-6">
                <RecordingCalendar
                  segments={allSegments}
                  selectedDate={selectedDate}
                  onSelectDate={setSelectedDate}
                />
                <div className="flex-1 min-w-0">
                  {dayError && <p className="text-xs text-signal-red mb-2">{dayError}</p>}
                  {!dayError && daySegments === null && <p className="text-xs text-slate-500">Loading this day…</p>}
                  {!dayError && daySegments !== null && (
                    <RecordingPlayer
                      cameraId={selectedCamera.id}
                      cameraName={selectedCamera.name}
                      segments={daySegments}
                      initialPlayFromIso={seekTargetIso}
                      onInitialSeekApplied={() => setSeekTargetIso(null)}
                    />
                  )}
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
