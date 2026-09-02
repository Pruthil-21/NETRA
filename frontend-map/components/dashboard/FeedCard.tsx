import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { CameraFeed } from "@/types/stream";
import { useInView } from "@/hooks/useInView";
import { createHoverGraceController, HoverGraceController } from "@/lib/hoverGrace";
import { Radio, VideoOff, AlertTriangle, HelpCircle, Maximize2, MapPin, Play, LucideIcon } from "lucide-react";

// hls.js is a large dependency only needed once a tile actually starts playing
// (hover-hold or click) -- code-split it out of the Dashboard's initial bundle
// the same way CameraMap is already split out of /map and /search for leaflet.
const HlsPlayer = dynamic(
  () => import("@/components/player/HlsPlayer").then((mod) => mod.HlsPlayer),
  { ssr: false, loading: () => <div className="w-full h-full bg-black" /> }
);

// Hover this long before a preview starts -- a quick mouse pass-over
// shouldn't spin up a decoder. Click always skips the wait.
const HOVER_PLAY_DELAY_MS = 2000;
// Once playing, keep playing this long after the mouse leaves before actually
// tearing the decoder down -- a quick re-hover (scanning across the grid, briefly
// crossing back onto this tile) shouldn't restart Hls.js from a cold manifest
// fetch every time.
const HOVER_LEAVE_GRACE_MS = 1200;

interface FeedCardProps {
  feed: CameraFeed;
  /** Present only when this card should offer a "focus this camera" affordance.
   * Takes the feed's own id -- CameraGrid passes this straight through instead of
   * pre-binding a per-tile closure, so the same onFocus reference works for every
   * tile and doesn't defeat React.memo below. */
  onFocus?: (id: string) => void;
  /** True when this card is the single camera an officer explicitly selected (focus
   * layout) -- that click already is the "play this" action, so skip the hover gate. */
  startPlaying?: boolean;
}

const STATUS_BADGE: Record<CameraFeed["status"], { label: string; className: string; icon: LucideIcon }> = {
  ONLINE: { label: "LIVE", className: "bg-red-950/80 border-red-800 text-red-400", icon: Radio },
  DEGRADED: { label: "DEGRADED", className: "bg-amber-950/80 border-amber-800 text-amber-400", icon: AlertTriangle },
  UNKNOWN: { label: "UNCONFIRMED", className: "bg-slate-900/80 border-slate-700 text-slate-400", icon: HelpCircle },
  OFFLINE: { label: "OFFLINE", className: "bg-gray-900 border-gray-700 text-gray-400", icon: VideoOff },
};

const FeedCardImpl: React.FC<FeedCardProps> = ({ feed, onFocus, startPlaying = false }) => {
  // UNKNOWN cameras aren't confirmed dead — still worth attempting playback; useHls's
  // own error handling covers the case where there's genuinely nothing there.
  const isPlayable = feed.status !== "OFFLINE";
  const badge = STATUS_BADGE[feed.status];
  const BadgeIcon = badge.icon;

  // Only start decoding video once this tile has actually been scrolled into view —
  // with dozens of registered cameras, mounting every player up front regardless of
  // visibility is real, wasted CPU/bandwidth on a tool officers may run on patrol
  // laptops or constrained connections.
  const [containerRef, inView] = useInView<HTMLDivElement>();

  // The streaming relay can only hold ~6 concurrent HLS decoders reliably (per the
  // streaming engineer -- more than that and playlists start taking 25s+ to load).
  // So playback is opt-in per tile: hover 3s or click to start, mouse-leave tears the
  // player down again. Badges/status still update on their own via the registry poll
  // in useCameraFeeds regardless of whether a tile is actively playing.
  const [isPlaying, setIsPlaying] = useState(startPlaying);
  // startPlaying can flip while this controller is alive (an officer double-clicking
  // into focus mode) -- read via a ref inside onEnd so that closure always sees the
  // current value instead of the one captured when the controller was created.
  const startPlayingRef = useRef(startPlaying);
  useEffect(() => {
    startPlayingRef.current = startPlaying;
  }, [startPlaying]);

  // Created once via useMemo rather than a lazy-init ref -- reading ref.current
  // during render (even guarded) trips react-hooks/refs; setIsPlaying and
  // startPlayingRef are both stable across renders, so an empty dep array still
  // matches the original once-per-mount intent.
  const hoverController: HoverGraceController = useMemo(
    () =>
      createHoverGraceController(
        HOVER_PLAY_DELAY_MS,
        HOVER_LEAVE_GRACE_MS,
        () => setIsPlaying(true),
        // startPlayingRef is only read once this callback actually runs, and
        // createHoverGraceController (lib/hoverGrace.ts) never calls onEnd
        // synchronously -- only from a setTimeout or a click handler, both always
        // outside the render pass. The rule can't see into that module to verify
        // this, so it flags a ref captured in a closure passed to another function
        // as a precaution; verified safe here.
        // eslint-disable-next-line react-hooks/refs
        () => {
          // A deliberately-focused single camera stays playing when the mouse wanders off
          // it (e.g. an officer reading the sidebar) -- only hover-previews in the grid
          // tear down on mouse-leave.
          if (!startPlayingRef.current) setIsPlaying(false);
        }
      ),
    []
  );

  const handleMouseEnter = useCallback(() => hoverController.hoverStart(), [hoverController]);
  const handleMouseLeave = useCallback(() => hoverController.hoverEnd(), [hoverController]);
  const handleClick = useCallback(() => hoverController.forceStart(), [hoverController]);

  useEffect(() => hoverController.cancel, [hoverController]);

  return (
    <div
      className={`bg-brand-card border border-brand-border rounded-lg overflow-hidden flex flex-col shadow-lg transition-transform duration-300 ease-out ${
        isPlaying ? 'scale-[1.06] shadow-2xl relative z-10' : 'scale-100'
      }`}
    >
      <div className="p-3 border-b border-brand-border flex items-center justify-between bg-gray-900/40">
        <div>
          <h3 className="font-semibold text-sm text-gray-100">{feed.name}</h3>
          <p className="text-xs text-gray-400 flex items-center gap-1.5">
            <span>{feed.department} • {feed.location}</span>
            {/* (0, 0) means "no real location yet" (e.g. a manually-added test feed
                pending a proper registry entry) — a maps link there would be misleading. */}
            {(feed.lat !== 0 || feed.long !== 0) && (
              <a
                href={`https://www.google.com/maps?q=${feed.lat},${feed.long}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-blue-400 hover:underline"
                title="Open this camera's location in Google Maps"
              >
                <MapPin className="w-3 h-3" />
                Map
              </a>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className={`flex items-center space-x-1.5 border text-[10px] font-bold px-2 py-0.5 rounded ${badge.className}`}>
            <BadgeIcon className={`w-3 h-3 ${feed.status === "ONLINE" ? "animate-pulse" : ""}`} />
            <span>{badge.label}</span>
          </div>
          {onFocus && (
            <button
              onClick={() => onFocus?.(feed.id)}
              aria-label={`Focus on ${feed.name}`}
              title="Focus this camera"
              className="p-1 rounded bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <div
        ref={containerRef}
        className="relative aspect-video w-full bg-black cursor-pointer"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      >
        {!isPlayable ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-gray-600">
            <VideoOff className="w-8 h-8" />
            <span className="text-xs text-gray-500">Feed unavailable</span>
          </div>
        ) : !inView ? (
          <div className="w-full h-full flex items-center justify-center text-gray-700 text-xs">
            Scroll into view to load feed…
          </div>
        ) : isPlaying ? (
          <HlsPlayer src={feed.hlsUrl} />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-gray-600">
            <Play className="w-8 h-8" />
            <span className="text-xs text-gray-500">Hover or click to play live feed</span>
          </div>
        )}
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

// Wrapped so a poll tick that leaves this tile's feed object reference unchanged
// (see mergeFeedStatus in hooks/useCameraFeeds.ts) skips re-rendering it entirely --
// including tiles with a live HlsPlayer mounted, which is the expensive case this
// is actually for.
export const FeedCard = React.memo(FeedCardImpl);
