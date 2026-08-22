import React from "react";
import { CameraFeed } from "@/types/stream";
import { HlsPlayer } from "@/components/player/HlsPlayer";
import { Radio } from "lucide-react";

interface FeedCardProps {
  feed: CameraFeed;
}

export const FeedCard: React.FC<FeedCardProps> = ({ feed }) => {
  return (
    <div className="bg-brand-card border border-brand-border rounded-lg overflow-hidden flex flex-col shadow-lg">
      <div className="p-3 border-b border-brand-border flex items-center justify-between bg-gray-900/40">
        <div>
          <h3 className="font-semibold text-sm text-gray-100">{feed.name}</h3>
          <p className="text-xs text-gray-400">{feed.department} • {feed.location}</p>
        </div>
        <div className="flex items-center space-x-1.5 bg-red-950/80 border border-red-800 text-red-400 text-[10px] font-bold px-2 py-0.5 rounded">
          <Radio className="w-3 h-3 animate-pulse text-red-500" />
          <span>LIVE</span>
        </div>
      </div>
      <div className="relative aspect-video w-full bg-black">
        <HlsPlayer src={feed.hlsUrl} />
      </div>
      <div className="p-2.5 bg-gray-900/80 text-[11px] text-gray-400 flex justify-between items-center">
        <span>ID: <span className="font-mono text-gray-300">{feed.id}</span></span>
        <span className="text-emerald-400 font-medium">HLS Stream active</span>
      </div>
    </div>
  );
};