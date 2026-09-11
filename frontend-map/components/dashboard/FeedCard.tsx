import React, { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { CameraFeed } from "@/types/stream";
import { useInView } from "@/hooks/useInView";
import { createHoverGraceController, HoverGraceController } from "@/lib/hoverGrace";
import { Radio, VideoOff, AlertTriangle, HelpCircle, MapPin, Play, GripVertical, X, LucideIcon } from "lucide-react";

const HlsPlayer = dynamic(
  () => import("@/components/player/HlsPlayer").then((mod) => mod.HlsPlayer),
  { ssr: false, loading: () => <div className="w-full h-full bg-black" /> }
);

const HOVER_PREVIEW_DELAY_MS = 2000;
const HOVER_PREVIEW_GRACE_MS = 1200;

interface FeedCardProps {
  feed: CameraFeed;
  /** "playAll": tile plays inline whenever `isPlaying` is true (Play-All toggle
   * in GridControls). "hoverOnly" (default elsewhere in this app): tile stays
   * a static thumbnail; hover reports to the parent via onHoverStart/onHoverEnd
   * so it can open the shared CameraInfoOverlay instead of playing inline. */
  mode?: 'playAll' | 'hoverOnly';
  isPlaying?: boolean;
  onHoverStart?: (id: string) => void;
  onHoverEnd?: (id: string) => void;
  /** Present only when tiles in this grid can be dragged into a new order --
   * absent in focus layout, where there's only one tile. Called with the
   * dragged feed's id and this card's own id (the drop target). */
  onReorder?: (draggedId: string, targetId: string) => void;
  /** Present only when this tile is part of an officer's drag-composed
   * watch set (dragged in from DistrictAreaTree, see CameraGrid's
   * onDropCameraIds) -- renders a small remove button so any one stream can
   * be pulled back out without clearing the whole set. */
  onRemove?: (id: string) => void;
  /** True only for tiles in the drag-composed watch set -- an officer built
   * this exact grid to watch footage, not to browse metadata, so the name/
   * dept/Map/status/ID chrome that's useful in the normal browsing grid
   * (its own header+footer bars) would just be dead space here. Renders the
   * video edge-to-edge instead, with the camera's name and the remove
   * control as small overlays on top of it rather than bars around it. */
  immersive?: boolean;
}

const STATUS_BADGE: Record<CameraFeed["status"], { label: string; className: string; icon: LucideIcon }> = {
  ONLINE: { label: "LIVE", className: "bg-red-950/80 border-red-800 text-red-400", icon: Radio },
  DEGRADED: { label: "DEGRADED", className: "bg-amber-950/80 border-amber-800 text-amber-400", icon: AlertTriangle },
  UNKNOWN: { label: "UNCONFIRMED", className: "bg-slate-900/80 border-slate-700 text-slate-400", icon: HelpCircle },
  OFFLINE: { label: "OFFLINE", className: "bg-gray-900 border-gray-700 text-gray-400", icon: VideoOff },
};

const FeedCardImpl: React.FC<FeedCardProps> = ({
  feed, mode = 'hoverOnly', isPlaying = false, onHoverStart, onHoverEnd, onReorder, onRemove,
  immersive = false,
}) => {
  // Any tile that can be one of several *simultaneously* decoding streams
  // (immersive watch-set, or the grid's own Play All -- both cap at
  // MAX_CONCURRENT_PLAYERS) risks the periodic server-side reachability probe
  // (see useCameraFeeds.ts) timing out from that same burst of decoder
  // traffic and mislabeling a feed OFFLINE even though the stream itself is
  // fine. Trusting that probe here would yank a genuinely live player out
  // under load, so for those modes the player's own error state (surfaced by
  // HlsPlayer/useHls, which retries on its own) is the real source of truth
  // instead. hoverOnly stays probe-gated -- only one stream plays at a time
  // there, so there's no contention to false-negative on, and it's the
  // signal that keeps a browsing grid from attempting playback on cameras
  // that are genuinely down.
  const isPlayable = mode === 'playAll' || feed.status !== "OFFLINE";
  const badge = STATUS_BADGE[feed.status];
  const BadgeIcon = badge.icon;

  const [containerRef, inView] = useInView<HTMLDivElement>();

  // hoverOnly mode: reports hover start/end to the parent (which owns the
  // shared hoveredCameraId state driving CameraInfoOverlay) after the same
  // hold/grace choreography the old inline hover-play used.
  const hoverController: HoverGraceController = useMemo(
    () =>
      createHoverGraceController(
        HOVER_PREVIEW_DELAY_MS,
        HOVER_PREVIEW_GRACE_MS,
        () => onHoverStart?.(feed.id),
        () => onHoverEnd?.(feed.id)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feed.id]
  );

  const handleMouseEnter = useCallback(() => {
    if (mode === 'hoverOnly') hoverController.hoverStart();
  }, [mode, hoverController]);
  const handleMouseLeave = useCallback(() => {
    if (mode === 'hoverOnly') hoverController.hoverEnd();
  }, [mode, hoverController]);

  useEffect(() => hoverController.cancel, [hoverController]);

  // `isPlaying` (Play-All mode) is gated upstream by useLimitedPlayers -- the
  // streaming relay can only hold a handful (~6) of concurrent HLS decoders
  // reliably, so only that many tiles are ever actually playing at once; the
  // rest render the "Queued" placeholder below instead of a player. See
  // useLimitedPlayers.ts for the actual cap/eviction logic.
  const shouldRenderPlayer = mode === 'playAll' && isPlaying && isPlayable && inView;

  // Native HTML5 DnD -- reordering happens within a single grid, so there's no
  // need for a full drag-and-drop library. dataTransfer carries only the
  // dragged feed's own id; onReorder (from useTileOrder, via CameraGrid) does
  // the actual splice-and-persist.
  const [isDragOver, setIsDragOver] = useState(false);
  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.dataTransfer.setData("text/plain", feed.id);
      e.dataTransfer.effectAllowed = "move";
    },
    [feed.id]
  );
  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!onReorder) return;
      e.preventDefault();
      setIsDragOver(true);
    },
    [onReorder]
  );
  const handleDragLeave = useCallback(() => setIsDragOver(false), []);
  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!onReorder) return;
      e.preventDefault();
      setIsDragOver(false);
      const draggedId = e.dataTransfer.getData("text/plain");
      if (draggedId) onReorder(draggedId, feed.id);
    },
    [onReorder, feed.id]
  );

  const videoArea = !isPlayable ? (
    <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-gray-600">
      <VideoOff className="w-8 h-8" />
      <span className="text-xs text-gray-500">Feed unavailable</span>
    </div>
  ) : shouldRenderPlayer ? (
    <div data-testid="hls-player" className="w-full h-full">
      <HlsPlayer src={feed.hlsUrl} />
    </div>
  ) : (
    <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-gray-600">
      <Play className="w-8 h-8" />
      <span className="text-xs text-gray-500">
        {mode === 'playAll' ? 'Queued — waiting for a free decoder slot' : 'Hover to preview this camera'}
      </span>
    </div>
  );

  if (immersive) {
    // Edge-to-edge footage, nothing else competing for space -- name and
    // remove are small overlays layered on top of the video instead of
    // bars taking their own row above/below it.
    return (
      <div className="relative w-full h-full bg-black border border-gray-800 overflow-hidden">
        <div
          ref={containerRef}
          data-testid="feed-card-viewport"
          className="absolute inset-0"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {videoArea}
        </div>

        <div className="absolute top-2 left-2 right-2 flex items-start justify-between gap-2 pointer-events-none">
          <div className="flex items-center gap-1.5 min-w-0 pointer-events-auto bg-black/60 backdrop-blur-sm rounded px-2 py-1">
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                feed.status === 'ONLINE' ? 'bg-red-500 animate-pulse' : feed.status === 'OFFLINE' ? 'bg-gray-500' : 'bg-amber-500'
              }`}
              aria-hidden="true"
            />
            <span className="text-xs font-medium text-white truncate">{feed.name}</span>
          </div>
          {onRemove && (
            <button
              onClick={() => onRemove(feed.id)}
              aria-label={`Remove ${feed.name} from the grid`}
              title="Remove from grid"
              className="pointer-events-auto shrink-0 p-1 rounded bg-black/60 backdrop-blur-sm text-gray-300 hover:bg-red-950 hover:text-red-300 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      draggable={!!onReorder}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`bg-panel border rounded-lg overflow-hidden flex flex-col shadow-lg ${
        isDragOver ? 'border-blue-500 border-2' : 'border-line'
      }`}
    >
      <div className="p-3 border-b border-line flex items-center justify-between bg-gray-900/40">
        <div className="flex items-center gap-1.5 min-w-0">
          {onReorder && (
            <GripVertical
              className="w-3.5 h-3.5 text-gray-600 shrink-0 cursor-grab active:cursor-grabbing"
              aria-hidden="true"
            />
          )}
          <div className="min-w-0">
            <h3 className="font-semibold text-sm text-gray-100">{feed.name}</h3>
            <p className="text-xs text-gray-400 flex items-center gap-1.5 min-w-0">
              <span className="truncate">{feed.department} • {feed.location}</span>
              {/* (0, 0) means "no real location yet" (e.g. a manually-added test feed
                  pending a proper registry entry) — a maps link there would be misleading.
                  shrink-0 + the span's own truncate above is what keeps this pinned in
                  place instead of drifting out of alignment for a camera with a long
                  department/location string. */}
              {(feed.lat !== 0 || feed.long !== 0) && (
                <a
                  href={`https://www.google.com/maps?q=${feed.lat},${feed.long}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-blue-400 hover:underline shrink-0"
                  title="Open this camera's location in Google Maps"
                >
                  <MapPin className="w-3 h-3" />
                  Map
                </a>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className={`flex items-center space-x-1.5 border text-[10px] font-bold px-2 py-0.5 rounded ${badge.className}`}>
            <BadgeIcon className={`w-3 h-3 ${feed.status === "ONLINE" ? "animate-pulse" : ""}`} />
            <span>{badge.label}</span>
          </div>
          {onRemove && (
            <button
              onClick={() => onRemove(feed.id)}
              aria-label={`Remove ${feed.name} from the grid`}
              title="Remove from grid"
              className="p-1 rounded bg-gray-800 text-gray-400 hover:bg-red-950 hover:text-red-300 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <div
        ref={containerRef}
        data-testid="feed-card-viewport"
        className="relative aspect-video w-full bg-black cursor-pointer"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {videoArea}
      </div>
      <div className="p-2.5 bg-gray-900/80 text-[11px] text-gray-400 flex justify-between items-center">
        <span>ID: <span className="font-mono text-gray-300">{feed.id}</span></span>
        <span className={isPlayable ? "text-emerald-400 font-medium" : "text-gray-500 font-medium"}>
          {isPlayable ? "HLS Stream active" : "No signal"}
        </span>
      </div>
    </div>
  );
};

export const FeedCard = React.memo(FeedCardImpl);
