"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CameraGrid } from "@/components/dashboard/CameraGrid";
import { GridControls } from "@/components/dashboard/GridControls";
import { AlertLog } from "@/components/dashboard/AlertLog";
import { AlertBanner, Alert } from "@/components/AlertBanner";
import { StaleIndicator, useStaleness } from "@/components/common/StaleIndicator";
import { useCameraFeeds, FEED_STALE_THRESHOLD_MS } from "@/hooks/useCameraFeeds";
import { useLimitedPlayers } from "@/hooks/useLimitedPlayers";
import { useCameraRegistry } from "@/context/CameraRegistryContext";
import { CameraFeed } from "@/types/stream";
import { TEST_FEEDS } from "@/config/streams";
import { DistrictCircleTree, TreeSelection } from "@/components/tree/DistrictCircleTree";
import { CameraInfoOverlay } from "@/components/overlay/CameraInfoOverlay";
import { circlesService, Circle } from "@/services/circlesService";
import { filterFeedsByTreeSelection } from "@/lib/dashboardTreeFilter";

type StatusFilter = CameraFeed["status"] | "all";
const MAX_CONCURRENT_PLAYERS = 6;

export default function DashboardPage() {
  const { feeds, loading, error, refetch, lastUpdated } = useCameraFeeds();
  const { cameras } = useCameraRegistry();
  const { isStale } = useStaleness(lastUpdated, !!error, FEED_STALE_THRESHOLD_MS);
  const [layout, setLayout] = useState<"grid-4" | "grid-9" | "focus">("grid-9");
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [allAlerts, setAllAlerts] = useState<Alert[]>([]);
  const [playAllMode, setPlayAllMode] = useState(false);
  const [treeSelection, setTreeSelection] = useState<TreeSelection>(null);
  const [circles, setCircles] = useState<Circle[]>([]);
  const [hoveredCameraId, setHoveredCameraId] = useState<string | null>(null);

  const { activeCameraIds, openPlayer } = useLimitedPlayers(MAX_CONCURRENT_PLAYERS);

  useEffect(() => {
    circlesService.listCircles().then(setCircles).catch(() => {
      // Non-fatal: the tree just shows no circles until this succeeds/retries.
    });
  }, []);

  const allFeeds = useMemo(() => [...feeds, ...TEST_FEEDS], [feeds]);

  const districts = useMemo(
    () => Array.from(new Set(allFeeds.map((f) => f.department))).sort(),
    [allFeeds]
  );

  const circleIdByCameraId = useMemo(() => {
    const map: Record<string, number | null> = {};
    for (const cam of cameras) map[String(cam.id)] = cam.circle_id ?? null;
    return map;
  }, [cameras]);

  const treeFilteredFeeds = useMemo(
    () => filterFeedsByTreeSelection(allFeeds, treeSelection, circleIdByCameraId),
    [allFeeds, treeSelection, circleIdByCameraId]
  );

  const filteredFeeds = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return treeFilteredFeeds.filter((feed) => {
      if (statusFilter !== "all" && feed.status !== statusFilter) return false;
      if (!term) return true;
      return (
        feed.name.toLowerCase().includes(term) ||
        feed.id.toLowerCase().includes(term) ||
        feed.location.toLowerCase().includes(term) ||
        feed.department.toLowerCase().includes(term)
      );
    });
  }, [treeFilteredFeeds, searchTerm, statusFilter]);

  const visibleFeeds = useMemo(() => {
    if (layout !== "focus") return filteredFeeds;
    const focused = filteredFeeds.find((f) => f.id === focusedId);
    return focused ? [focused] : filteredFeeds.slice(0, 1);
  }, [layout, filteredFeeds, focusedId]);

  const hoveredCamera = useMemo(
    () => (hoveredCameraId ? cameras.find((c) => String(c.id) === hoveredCameraId) ?? null : null),
    [cameras, hoveredCameraId]
  );
  const hoveredCircleName = useMemo(
    () => circles.find((c) => c.id === hoveredCamera?.circle_id)?.name ?? null,
    [circles, hoveredCamera]
  );

  // Jumping to a camera (from an alert's "View Camera"/plate link) must always land on
  // that camera, regardless of what's currently selected in the tree -- otherwise the
  // tree-selection gate either shows the "pick a district" empty state (nothing selected
  // yet) or silently falls back to the first camera in a different district/circle's
  // filtered list (something else selected). Selecting the target's whole *district*
  // (not resolving its circle) guarantees inclusion without a circle lookup, since
  // district-selection already covers every camera in it regardless of circle assignment.
  const handleSelectFocus = useCallback((id: string) => {
    setFocusedId(id);
    setLayout("focus");
    setStatusFilter("all");
    setSearchTerm("");
    const targetFeed = allFeeds.find((f) => f.id === id);
    if (targetFeed) {
      setTreeSelection({ type: "district", value: targetFeed.department });
    }
  }, [allFeeds]);

  // Tracks whether the cursor is currently over the shared CameraInfoOverlay
  // itself (set by that component's onMouseEnterOverlay/onMouseLeaveOverlay
  // below). The overlay renders fixed inset-0 over whatever tile it opened
  // on top of, so that tile's own onMouseLeave fires as soon as the overlay
  // appears -- without this check, handleHoverEnd would clear
  // hoveredCameraId right back out (closing the overlay) the moment its own
  // hover-grace timer elapsed, only for the tile to "re-enter" once the
  // overlay closes and reopen it a moment later: an open/close/reopen
  // flicker loop. The overlay's own onMouseLeaveOverlay is what actually
  // closes it once the cursor truly leaves.
  const overlayHoveredRef = useRef(false);

  const handleHoverStart = useCallback(
    (id: string) => setHoveredCameraId(id),
    []
  );
  const handleHoverEnd = useCallback(
    (id: string) =>
      setHoveredCameraId((current) => (current === id && !overlayHoveredRef.current ? null : current)),
    []
  );

  // Play-All mode opens every currently-visible tile through the shared
  // concurrency-limited player pool instead of an unbounded number of
  // simultaneous HLS decoders (see Global Constraints — the relay reliably
  // holds ~6 at once; useLimitedPlayers evicts the oldest past that). Capped
  // client-side to the same MAX_CONCURRENT_PLAYERS instead of opening every
  // visible feed and letting useLimitedPlayers evict down to the last six --
  // that eviction order left whichever six were opened *last* active and
  // showed a permanent "Queued" message on the earlier tiles even though
  // they'd actually been played-then-evicted, not genuinely queued.
  useEffect(() => {
    if (!playAllMode) return;
    visibleFeeds.slice(0, MAX_CONCURRENT_PLAYERS).forEach((feed) => {
      // TEST_FEEDS entries can carry a non-numeric string id (e.g.
      // "xiaomi-camera") -- Number(...) on those is NaN, which would
      // otherwise occupy one of the six player slots and never resolve back
      // to a real feed.
      const numericId = Number(feed.id);
      if (!Number.isNaN(numericId)) openPlayer(numericId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playAllMode, visibleFeeds]);

  return (
    <main className="flex-1 flex overflow-hidden min-h-0 w-full">
      <DistrictCircleTree
        districts={districts}
        circles={circles}
        cameras={cameras}
        selected={treeSelection}
        onSelect={setTreeSelection}
      />

      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
        <AlertBanner onAlertsUpdate={setAllAlerts} onJumpToCamera={handleSelectFocus} />

        <div className="flex-1 p-4 sm:p-6">
          <div className="mb-6 flex justify-between items-center">
            <div className={isStale ? "opacity-60 transition-opacity" : "transition-opacity"}>
              <h2 className="text-lg font-semibold text-white">Live Operations Feeds</h2>
              <p className="text-xs text-gray-400">
                {loading
                  ? "Connecting to camera registry..."
                  : `${feeds.length} camera${feeds.length === 1 ? "" : "s"} registered`}
              </p>
            </div>
            {!loading && <StaleIndicator lastUpdated={lastUpdated} hasError={!!error} pollIntervalMs={FEED_STALE_THRESHOLD_MS} />}
          </div>

          <AlertLog alerts={allAlerts} onJumpToCamera={handleSelectFocus} />

          <GridControls
            layout={layout}
            setLayout={setLayout}
            searchTerm={searchTerm}
            setSearchTerm={setSearchTerm}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            playAllMode={playAllMode}
            setPlayAllMode={setPlayAllMode}
          />

          {loading && (
            <div className="flex items-center justify-center p-12 text-gray-400 text-sm">
              Loading camera feeds...
            </div>
          )}

          {!loading && error && (
            <div className="bg-brand-card border border-red-800/60 text-red-400 p-4 rounded-lg mb-6 flex items-center justify-between gap-4">
              <div>
                <p className="font-semibold text-sm">Camera registry unavailable</p>
                <p className="text-xs text-gray-400 mt-1">{error}</p>
              </div>
              <button
                onClick={refetch}
                className="shrink-0 px-3 py-1.5 rounded bg-red-900/60 hover:bg-red-900 text-red-200 text-xs font-semibold transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && treeSelection === null ? (
            <div className="text-center py-16 border border-dashed border-gray-800 rounded-lg">
              <p className="text-gray-400 text-sm">Pick a district (or an area within it) from the tree to view its cameras.</p>
            </div>
          ) : (
            !loading && (
              <div className={isStale ? "opacity-60 grayscale-[30%] transition-all" : "transition-all"}>
                <CameraGrid
                  feeds={visibleFeeds}
                  layout={layout}
                  onSelectFocus={handleSelectFocus}
                  registryEmpty={allFeeds.length === 0}
                  mode={playAllMode ? 'playAll' : 'hoverOnly'}
                  activeIds={new Set(Array.from(activeCameraIds).map(String))}
                  onHoverStart={handleHoverStart}
                  onHoverEnd={handleHoverEnd}
                />
              </div>
            )
          )}
        </div>
      </div>

      <CameraInfoOverlay
        camera={hoveredCamera}
        circleName={hoveredCircleName}
        onClose={() => setHoveredCameraId(null)}
        onMouseEnterOverlay={() => {
          overlayHoveredRef.current = true;
        }}
        onMouseLeaveOverlay={() => {
          overlayHoveredRef.current = false;
        }}
      />
    </main>
  );
}
