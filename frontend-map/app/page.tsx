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
import { useTileOrder } from "@/hooks/useTileOrder";
import { CameraFeed } from "@/types/stream";
import { DistrictCircleTree, TreeSelection } from "@/components/tree/DistrictCircleTree";
import { CameraRegistrySidebar } from "@/components/registry/CameraRegistrySidebar";
import { CameraInfoOverlay } from "@/components/overlay/CameraInfoOverlay";
import { circlesService, Circle } from "@/services/circlesService";
import { filterFeedsByTreeSelection } from "@/lib/dashboardTreeFilter";
import { usePermissions } from "@/hooks/usePermissions";
import { useImmersiveMode } from "@/context/ImmersiveModeContext";
import { useFullscreen } from "@/hooks/useFullscreen";
import { Maximize2, Minimize2 } from "lucide-react";

type StatusFilter = CameraFeed["status"] | "all";
const MAX_CONCURRENT_PLAYERS = 6;

export default function DashboardPage() {
  const { feeds, loading, error, refetch, lastUpdated } = useCameraFeeds();
  const { cameras } = useCameraRegistry();
  const { scopeValue: homeDistrict } = usePermissions();
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
  // Cameras an officer dragged in from the sidebar tree, rather than picked
  // via the tree-selection filter -- while this is non-empty it takes over
  // what the grid shows entirely (see visibleFeeds below), auto-sized to
  // however many are in it instead of the fixed grid-4/grid-9/focus layouts.
  const [watchSetIds, setWatchSetIds] = useState<Set<string>>(new Set());
  const [watchSetNotice, setWatchSetNotice] = useState<string | null>(null);

  const { activeCameraIds, openPlayer } = useLimitedPlayers(MAX_CONCURRENT_PLAYERS);

  useEffect(() => {
    circlesService.listCircles().then(setCircles).catch(() => {
      // Non-fatal: the tree just shows no circles until this succeeds/retries.
    });
  }, []);

  const districts = useMemo(
    () => Array.from(new Set(feeds.map((f) => f.department))).sort(),
    [feeds]
  );

  const circleIdByCameraId = useMemo(() => {
    const map: Record<string, number | null> = {};
    for (const cam of cameras) map[String(cam.id)] = cam.circle_id ?? null;
    return map;
  }, [cameras]);

  const treeFilteredFeeds = useMemo(
    () => filterFeedsByTreeSelection(feeds, treeSelection, circleIdByCameraId),
    [feeds, treeSelection, circleIdByCameraId]
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

  // An officer's drag-to-reorder preference, applied on top of the filtered set --
  // reordering is meaningless in focus mode (exactly one tile), so that layout skips
  // straight to filteredFeeds instead of going through the ordered list.
  const filteredFeedIds = useMemo(() => filteredFeeds.map((f) => f.id), [filteredFeeds]);
  const { orderedIds, moveTile } = useTileOrder(filteredFeedIds);
  const orderedFeeds = useMemo(() => {
    const byId = new Map(filteredFeeds.map((f) => [f.id, f]));
    return orderedIds.map((id) => byId.get(id)).filter((f): f is CameraFeed => f !== undefined);
  }, [orderedIds, filteredFeeds]);

  const isWatchMode = watchSetIds.size > 0;
  const { setImmersive } = useImmersiveMode();
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen();
  // AppShell's own persistent nav/header lives in a different component
  // tree than this page -- ImmersiveModeContext is how "hide the app chrome
  // too, not just this page's own header/sidebar" reaches it. Resets on
  // unmount so leaving the Dashboard page (not just exiting watch mode)
  // can never leave the rest of the app stuck without its nav bar.
  useEffect(() => {
    setImmersive(isWatchMode);
    return () => setImmersive(false);
  }, [isWatchMode, setImmersive]);
  const watchSetFeeds = useMemo(
    () => feeds.filter((f) => watchSetIds.has(f.id)),
    [feeds, watchSetIds]
  );
  const handleDropCameraIds = useCallback((cameraIds: number[]) => {
    setWatchSetIds((prev) => {
      const next = new Set(prev);
      let dropped = 0;
      for (const id of cameraIds) {
        const key = String(id);
        if (next.has(key)) continue;
        if (next.size >= MAX_CONCURRENT_PLAYERS) {
          dropped += 1;
          continue;
        }
        next.add(key);
      }
      if (dropped > 0) {
        setWatchSetNotice(
          `Only added ${MAX_CONCURRENT_PLAYERS - prev.size} of ${cameraIds.length} cameras — ${MAX_CONCURRENT_PLAYERS} concurrent streams is the limit for smooth playback.`
        );
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!watchSetNotice) return;
    const timer = setTimeout(() => setWatchSetNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [watchSetNotice]);

  const handleRemoveFromWatchSet = useCallback((id: string) => {
    setWatchSetIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Focus mode shows exactly one camera — the one explicitly picked via a FeedCard's
  // "Focus this camera" button, an alert's "View Camera"/plate link, or the first
  // filtered result if none was picked yet. A drag-composed watch set takes over
  // entirely ahead of this -- it's a deliberate, explicit pick, same as focus, just
  // for however many cameras were dragged in rather than exactly one.
  const visibleFeeds = useMemo(() => {
    if (isWatchMode) return watchSetFeeds;
    if (layout !== "focus") return orderedFeeds;
    const focused = filteredFeeds.find((f) => f.id === focusedId);
    return focused ? [focused] : filteredFeeds.slice(0, 1);
  }, [isWatchMode, watchSetFeeds, layout, orderedFeeds, filteredFeeds, focusedId]);

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
    const targetFeed = feeds.find((f) => f.id === id);
    if (targetFeed) {
      setTreeSelection({ type: "district", value: targetFeed.department });
    }
  }, [feeds]);

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
      // A non-numeric feed id (defensive -- every real registry camera has a
      // numeric one) would otherwise occupy one of the six player slots and
      // never resolve back to a real feed.
      const numericId = Number(feed.id);
      if (!Number.isNaN(numericId)) openPlayer(numericId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playAllMode, visibleFeeds]);

  // Theater mode: an officer dragging cameras in wants to watch them, not
  // navigate or read alerts, so the top nav/header/alerts/controls go right
  // away (see the setImmersive effect above and AppShell's own isImmersive
  // check). The camera registry sidebar is the one exception -- it's the
  // only way to drag *more* cameras in, so it stays until the officer takes
  // the extra, explicit step of going true fullscreen (isFullscreen): that's
  // the point where "entire screen should be only of custom viewer" really
  // applies, since there's no browser chrome left to reach it through
  // anyway once fullscreen hides the tab/URL bar too.
  if (isWatchMode) {
    return (
      <main className="flex-1 flex overflow-hidden min-h-0 w-full bg-black">
        {!isFullscreen && (
          <div className="w-56 shrink-0 h-full border-r border-line">
            <DistrictCircleTree
              districts={districts}
              circles={circles}
              cameras={cameras}
              selected={treeSelection}
              onSelect={setTreeSelection}
              homeDistrict={homeDistrict}
              defaultCollapsed
            />
          </div>
        )}

        <div className="relative flex-1 min-h-0">
          <CameraGrid
            feeds={visibleFeeds}
            layout={layout}
            registryEmpty={feeds.length === 0}
            mode="playAll"
            activeIds={watchSetIds}
            onHoverStart={handleHoverStart}
            onHoverEnd={handleHoverEnd}
            onDropCameraIds={handleDropCameraIds}
            immersive
            onRemove={handleRemoveFromWatchSet}
          />

          <div className="absolute top-3 right-3 z-20 flex items-center gap-2">
            {watchSetNotice && (
              <div className="text-xs bg-amber-950/80 backdrop-blur-sm border border-amber-800 text-amber-300 rounded-lg px-3 py-1.5">
                {watchSetNotice}
              </div>
            )}
            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              title={
                isFullscreen
                  ? "Exit fullscreen"
                  : "Enter fullscreen — hides the camera registry and the browser's own tabs/toolbar too"
              }
              className="p-2 rounded bg-black/60 backdrop-blur-sm border border-line text-slate-300 hover:text-white hover:bg-black/80 transition-colors"
            >
              {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button
              type="button"
              onClick={() => setWatchSetIds(new Set())}
              className="px-3 py-2 rounded bg-black/60 backdrop-blur-sm border border-line text-xs font-semibold text-slate-300 hover:text-white hover:bg-black/80 transition-colors"
            >
              Exit custom view
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 flex overflow-hidden min-h-0 w-full relative">
      <CameraRegistrySidebar
        districts={districts}
        circles={circles}
        cameras={cameras}
        selected={treeSelection}
        onSelect={setTreeSelection}
        homeDistrict={homeDistrict}
      />

      <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
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
            <div className="bg-panel border border-red-800/60 text-red-400 p-4 rounded-lg mb-6 flex items-center justify-between gap-4">
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

          {!loading && (
            <div className={isStale ? "opacity-60 grayscale-[30%] transition-all" : "transition-all"}>
              <CameraGrid
                feeds={visibleFeeds}
                layout={layout}
                onSelectFocus={handleSelectFocus}
                registryEmpty={feeds.length === 0}
                mode={playAllMode ? 'playAll' : 'hoverOnly'}
                activeIds={new Set(Array.from(activeCameraIds).map(String))}
                onHoverStart={handleHoverStart}
                onHoverEnd={handleHoverEnd}
                onReorder={moveTile}
                onDropCameraIds={handleDropCameraIds}
              />
            </div>
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
