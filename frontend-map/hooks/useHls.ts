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
  // Bumped after a fatal error to re-run the effect below and rebuild the
  // hls.js instance from scratch — a relay/tunnel blip is common and this is
  // what lets a tile recover on its own instead of showing "unreachable"
  // forever until something external (e.g. the tile being unmounted and
  // remounted) forces a fresh attempt.
  const [retryToken, setRetryToken] = useState(0);
  // Most fatal errors here are a brief contention blip (several tiles' decoders
  // starting at once, a tunnel hiccup) that clears within a second or two, so
  // the first retry is near-instant rather than a flat multi-second wait — this
  // is a live police feed, not a batch job. Backs off (1s/2s/4s, capped at 8s)
  // only if it keeps failing, so a genuinely dead stream isn't hammered in a
  // tight loop; resets to fast-retry the moment a manifest actually loads.
  const retryDelayRef = useRef(1000);
  const MIN_RETRY_DELAY_MS = 1000;
  const MAX_RETRY_DELAY_MS = 8000;

  useEffect(() => {
    setHasError(false);
    const video = videoRef.current;
    if (!video || !src) return;

    let hls: Hls | null = null;
    let nativeErrorHandler: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRetry = () => {
      setHasError(true);
      const delay = retryDelayRef.current;
      retryDelayRef.current = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
      retryTimer = setTimeout(() => setRetryToken((t) => t + 1), delay);
    };

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        retryDelayRef.current = MIN_RETRY_DELAY_MS;
        video.play().catch(() => {
          // Auto-play policy handled via muted state on video element
        });
      });
      // A dead/404ing stream previously just left a frozen black box with no
      // indication anything was wrong — surface fatal errors so the UI can show one,
      // and keep retrying instead of giving up (see retryToken above).
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) scheduleRetry();
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      nativeErrorHandler = () => scheduleRetry();
      video.addEventListener("error", nativeErrorHandler);
      video.addEventListener("loadedmetadata", () => {
        retryDelayRef.current = MIN_RETRY_DELAY_MS;
        video.play().catch(() => {});
      });
    }

    return () => {
      if (retryTimer) clearTimeout(retryTimer);
      if (hls) hls.destroy();
      if (nativeErrorHandler) video.removeEventListener("error", nativeErrorHandler);
    };
  }, [src, retryToken]);

  return { videoRef: videoRef as React.RefObject<HTMLVideoElement>, hasError };
};
