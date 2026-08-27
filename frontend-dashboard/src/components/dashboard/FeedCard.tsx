import React from "react";
import { CameraFeed } from "@/types/stream";
import { HlsPlayer } from "@/components/player/HlsPlayer";
import { Radio, VideoOff } from "lucide-react";

interface FeedCardProps {
  feed: CameraFeed;
}

const STATUS_BADGE: Record<CameraFeed["status"], { label: string; className: string }> = {
  ONLINE: { label: "LIVE", className: "bg-red-950/80 border-red-800 text-red-400" },
  DEGRADED: { label: "DEGRADED", className: "bg-amber-950/80 border-amber-800 text-amber-400" },
  OFFLINE: { label: "OFFLINE", className: "bg-gray-900 border-gray-700 text-gray-400" },
};

export const FeedCard: React.FC<FeedCardProps> = ({ feed }) => {
  const isPlayable = feed.status !== "OFFLINE";
  const badge = STATUS_BADGE[feed.status];

  return (
    <div className="bg-brand-card border border-brand-border rounded-lg overflow-hidden flex flex-col shadow-lg">
      <div className="p-3 border-b border-brand-border flex items-center justify-between bg-gray-900/40">
        <div>
          <h3 className="font-semibold text-sm text-gray-100">{feed.name}</h3>
          <p className="text-xs text-gray-400">{feed.department} • {feed.location}</p>
        </div>
        <div className={`flex items-center space-x-1.5 border text-[10px] font-bold px-2 py-0.5 rounded ${badge.className}`}>
          {isPlayable ? <Radio className="w-3 h-3 animate-pulse" /> : <VideoOff className="w-3 h-3" />}
          <span>{badge.label}</span>
        </div>
      </div>
      <div className="relative aspect-video w-full bg-black">
        {isPlayable ? (
          <HlsPlayer src={feed.hlsUrl} />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-gray-600">
            <VideoOff className="w-8 h-8" />
            <span className="text-xs text-gray-500">Feed unavailable</span>
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
