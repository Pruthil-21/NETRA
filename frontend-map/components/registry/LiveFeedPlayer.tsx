'use client';

import React, { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { Maximize, Minimize, RadioTower, VideoOff } from 'lucide-react';

type FeedStatus = 'connecting' | 'live' | 'error';

export default function LiveFeedPlayer({ src }: { src: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      containerRef.current.requestFullscreen().catch(() => {});
    }
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) {
      setStatus('error');
      return;
    }

    let cancelled = false;
    let onReady: (() => void) | null = null;
    let onError: (() => void) | null = null;
    setStatus('connecting');

    import('hls.js').then(({ default: HlsLib }) => {
      if (cancelled || !video) return;

      if (HlsLib.isSupported()) {
        const hls = new HlsLib({ maxBufferLength: 10, liveSyncDurationCount: 3 });
        hlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(HlsLib.Events.MANIFEST_PARSED, () => {
          if (cancelled) return;
          setStatus('live');
          video.play().catch(() => {});
        });
        hls.on(HlsLib.Events.ERROR, (_event, data) => {
          if (!cancelled && data.fatal) setStatus('error');
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari plays HLS natively without hls.js.
        onReady = () => {
          if (!cancelled) {
            setStatus('live');
            video.play().catch(() => {});
          }
        };
        onError = () => {
          if (!cancelled) setStatus('error');
        };
        video.addEventListener('loadedmetadata', onReady);
        video.addEventListener('error', onError);
        video.src = src;
      } else {
        setStatus('error');
      }
    });

    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (video) {
        if (onReady) video.removeEventListener('loadedmetadata', onReady);
        if (onError) video.removeEventListener('error', onError);
        video.removeAttribute('src');
      }
    };
  }, [src]);

  if (!src) {
    return (
      <div className="flex items-center justify-center h-full w-full bg-slate-950 text-slate-600 gap-2 text-[11px]">
        <VideoOff size={14} />
        Feed unavailable
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full h-full bg-black overflow-hidden group">
      <video ref={videoRef} muted playsInline autoPlay className="w-full h-full object-cover" />
      {status !== 'live' && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/90 text-slate-500 gap-2 text-[11px]">
          {status === 'error' ? (
            <>
              <VideoOff size={14} />
              Feed unavailable
            </>
          ) : (
            <>
              <RadioTower size={14} className="animate-pulse" />
              Connecting…
            </>
          )}
        </div>
      )}
      {status === 'live' && (
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'View fullscreen'}
          className="absolute bottom-1.5 right-1.5 p-1.5 rounded bg-black/60 text-slate-200 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity hover:bg-black/80"
        >
          {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
        </button>
      )}
    </div>
  );
}
