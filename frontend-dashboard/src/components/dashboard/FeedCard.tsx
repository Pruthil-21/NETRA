import React from "react";
import { CameraFeed } from "@/types/stream";
import { HlsPlayer } from "@/components/player/HlsPlayer";
import { useInView } from "@/hooks/useInView";
import { Radio, VideoOff, AlertTriangle, HelpCircle, Maximize2, MapPin, LucideIcon } from "lucide-react";

interface FeedCardProps {
  feed: CameraFeed;
  /** Present only when this card should offer a "focus this camera" affordance. */
  onFocus?: () => void;
}

const STATUS_BADGE: Record<CameraFeed["status"], { label: string; className: string; icon: LucideIcon }> = {
  ONLINE: { label: "LIVE", className: "bg-red-950/80 border-red-800 text-red-400", icon: Radio },
  DEGRADED: { label: "DEGRADED", className: "bg-amber-950/80 border-amber-800 text-amber-400", icon: AlertTriangle },
  UNKNOWN: { label: "UNCONFIRMED", className: "bg-slate-900/80 border-slate-700 text-slate-400", icon: HelpCircle },
  OFFLINE: { label: "OFFLINE", className: "bg-gray-900 border-gray-700 text-gray-400", icon: VideoOff },
};

export const FeedCard: React.FC<FeedCardProps> = ({ feed, onFocus }) => {
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

  return (
    <div className="bg-brand-card border border-brand-border rounded-lg overflow-hidden flex flex-col shadow-lg">
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
              onClick={onFocus}
              aria-label={`Focus on ${feed.name}`}
              title="Focus this camera"
              className="p-1 rounded bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <div ref={containerRef} className="relative aspect-video w-full bg-black">
        {!isPlayable ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-gray-600">
            <VideoOff className="w-8 h-8" />
            <span className="text-xs text-gray-500">Feed unavailable</span>
          </div>
        ) : inView ? (
          <HlsPlayer src={feed.hlsUrl} />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-700 text-xs">
            Scroll into view to load feed…
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
