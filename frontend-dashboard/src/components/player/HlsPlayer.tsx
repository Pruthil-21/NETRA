"use client";

import React from "react";
import { VideoOff } from "lucide-react";
import { useHls } from "@/hooks/useHls";

interface HlsPlayerProps {
  src: string;
  autoPlay?: boolean;
  muted?: boolean;
}

export const HlsPlayer: React.FC<HlsPlayerProps> = ({ src, autoPlay = true, muted = true }) => {
  const { videoRef, hasError } = useHls(src);

  if (hasError) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-gray-600 bg-black">
        <VideoOff className="w-8 h-8" />
        <span className="text-xs text-gray-500">Stream error — feed unreachable</span>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-black flex items-center justify-center overflow-hidden">
      <video
        ref={videoRef}
        className="w-full h-full object-cover"
        controls
        playsInline
        autoPlay={autoPlay}
        muted={muted}
      />
    </div>
  );
};
