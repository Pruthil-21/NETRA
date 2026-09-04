import React, { useCallback, useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { CameraFeed } from "@/types/stream";
import { useInView } from "@/hooks/useInView";
import { createHoverGraceController, HoverGraceController } from "@/lib/hoverGrace";
import { Radio, VideoOff, AlertTriangle, HelpCircle, Maximize2, MapPin, Play, LucideIcon } from "lucide-react";

const HlsPlayer = dynamic(
  () => import("@/components/player/HlsPlayer").then((mod) => mod.HlsPlayer),
  { ssr: false, loading: () => <div className="w-full h-full bg-black" /> }
);

const HOVER_PREVIEW_DELAY_MS = 2000;
const HOVER_PREVIEW_GRACE_MS = 1200;

interface FeedCardProps {
  feed: CameraFeed;
  onFocus?: (id: string) => void;
  startPlaying?: boolean;
  /** "playAll": tile plays inline whenever `isPlaying` is true (Play-All toggle
   * in GridControls). "hoverOnly" (default elsewhere in this app): tile stays
   * a static thumbnail; hover reports to the parent via onHoverStart/onHoverEnd
   * so it can open the shared CameraInfoOverlay instead of playing inline. */
  mode?: 'playAll' | 'hoverOnly';
  isPlaying?: boolean;
  onHoverStart?: (id: string) => void;
  onHoverEnd?: (id: string) => void;
}

const STATUS_BADGE: Record<CameraFeed["status"], { label: string; className: string; icon: LucideIcon }> = {
  ONLINE: { label: "LIVE", className: "bg-red-950/80 border-red-800 text-red-400", icon: Radio },
  DEGRADED: { label: "DEGRADED", className: "bg-amber-950/80 border-amber-800 text-amber-400", icon: AlertTriangle },
  UNKNOWN: { label: "UNCONFIRMED", className: "bg-slate-900/80 border-slate-700 text-slate-400", icon: HelpCircle },
  OFFLINE: { label: "OFFLINE", className: "bg-gray-900 border-gray-700 text-gray-400", icon: VideoOff },
};

const FeedCardImpl: React.FC<FeedCardProps> = ({
  feed, onFocus, startPlaying = false, mode = 'hoverOnly', isPlaying = false, onHoverStart, onHoverEnd,
}) => {
  const isPlayable = feed.status !== "OFFLINE";
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

  const shouldRenderPlayer = mode === 'playAll' && isPlaying && isPlayable && inView;

  return (
    <div
      className={`bg-brand-card border border-brand-border rounded-lg overflow-hidden flex flex-col shadow-lg transition-transform duration-300 ease-out ${
        shouldRenderPlayer ? 'scale-[1.06] shadow-2xl relative z-10' : 'scale-100'
      }`}
    >
      <div className="p-3 border-b border-brand-border flex items-center justify-between bg-gray-900/40">
        <div>
          <h3 className="font-semibold text-sm text-gray-100">{feed.name}</h3>
          <p className="text-xs text-gray-400 flex items-center gap-1.5">
            <span>{feed.department} • {feed.location}</span>
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
        data-testid="feed-card-viewport"
        className="relative aspect-video w-full bg-black cursor-pointer"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {!isPlayable ? (
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

export const FeedCard = React.memo(FeedCardImpl);
