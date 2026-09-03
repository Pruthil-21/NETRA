"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

interface UseHlsResult {
  videoRef: React.RefObject<HTMLVideoElement>;
  hasError: boolean;
}

export const useHls = (src: string): UseHlsResult => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
    const video = videoRef.current;
    if (!video || !src) return;

    let hls: Hls | null = null;
    let nativeErrorHandler: (() => void) | null = null;

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {
          // Auto-play policy handled via muted state on video element
        });
      });
      // A dead/404ing stream previously just left a frozen black box with no
      // indication anything was wrong — surface fatal errors so the UI can show one.
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) setHasError(true);
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      nativeErrorHandler = () => setHasError(true);
      video.addEventListener("error", nativeErrorHandler);
      video.addEventListener("loadedmetadata", () => {
        video.play().catch(() => {});
      });
    }

    return () => {
      if (hls) hls.destroy();
      if (nativeErrorHandler) video.removeEventListener("error", nativeErrorHandler);
    };
  }, [src]);

  return { videoRef: videoRef as React.RefObject<HTMLVideoElement>, hasError };
};
