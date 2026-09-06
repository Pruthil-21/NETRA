'use client';

import React, { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { Radio, VideoOff } from 'lucide-react';

/**
 * Lean, chrome-free live preview for the map popup's 2s-hover reveal —
 * deliberately not LiveFeedPlayer (retry ladder, watchdog, fullscreen button):
 * a hover preview that vanishes the instant the cursor leaves has no use for
 * any of that. No `controls` attribute, no on-screen buttons — the video
 * itself is the only thing in the frame besides the LIVE pulse.
 */
export default function MapPopupPreviewPlayer({ src }: { src: string | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    setIsLive(false);
    setHasError(false);
    if (!video || !src) return;

    let cancelled = false;

    import('hls.js').then(({ default: HlsLib }) => {
      if (cancelled || !video) return;

      if (HlsLib.isSupported()) {
        const hls = new HlsLib({
          lowLatencyMode: true,
          backBufferLength: 0,
          maxBufferLength: 4,
          maxMaxBufferLength: 6,
        });
        hlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(HlsLib.Events.MANIFEST_PARSED, () => {
          if (cancelled) return;
          video.play().catch(() => {});
        });
        hls.on(HlsLib.Events.ERROR, (_event, data) => {
          if (cancelled || !data.fatal) return;
          setHasError(true);
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
        video.addEventListener('error', () => !cancelled && setHasError(true));
        video.addEventListener('loadedmetadata', () => video.play().catch(() => {}));
      } else {
        setHasError(true);
      }
    });

    const onFirstFrame = () => !cancelled && setIsLive(true);
    video.addEventListener('loadeddata', onFirstFrame);

    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.removeEventListener('loadeddata', onFirstFrame);
      video.removeAttribute('src');
    };
  }, [src]);

  if (!src || hasError) {
    return (
      <div className="flex items-center justify-center w-full h-full bg-ink text-slate-600 gap-1.5 text-[10px]">
        <VideoOff size={12} />
        {hasError ? 'Preview unavailable' : 'No live feed'}
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-ink overflow-hidden">
      <video ref={videoRef} muted playsInline autoPlay className="w-full h-full object-contain" />
      {!isLive && (
        <div className="absolute inset-0 flex items-center justify-center bg-ink/90 text-slate-500 gap-1.5 text-[10px]">
          <Radio size={12} className="animate-pulse" />
          Connecting…
        </div>
      )}
      {isLive && (
        <span className="absolute top-1 left-1 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/60 text-signal-red text-[9px] font-bold font-mono tracking-wide">
          <span className="w-1.5 h-1.5 rounded-full bg-signal-red animate-pulse" />
          LIVE
        </span>
      )}
    </div>
  );
}
