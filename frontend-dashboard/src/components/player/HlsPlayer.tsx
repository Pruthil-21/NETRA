"use client";

import React from "react";
import { useHls } from "@/hooks/useHls";

interface HlsPlayerProps {
  src: string;
  autoPlay?: boolean;
  muted?: boolean;
}

export const HlsPlayer: React.FC<HlsPlayerProps> = ({ src, autoPlay = true, muted = true }) => {
  const videoRef = useHls(src);

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