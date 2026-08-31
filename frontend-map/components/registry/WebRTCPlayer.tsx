'use client';

import React, { useEffect, useRef, useState } from 'react';
import { RadioTower, Maximize, Minimize } from 'lucide-react';
import type { ConnectivityStatus } from '@/types/camera';
import { connectWhep, type WhepSession } from '@/lib/webrtc';

// One negotiation round trip; if it hasn't resolved by here, give up and let
// the caller (CameraLivePlayer) fall back to the LL-HLS path instead of
// leaving the drawer stuck on "Connecting…" forever.
const CONNECT_WATCHDOG_MS = 8000;

export default function WebRTCPlayer({
  whepUrl,
  onStatusChange,
  onFatalError,
}: {
  whepUrl: string;
  preliminaryStatus?: ConnectivityStatus;
  onStatusChange?: (status: ConnectivityStatus) => void;
  onFatalError: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isLive, setIsLive] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);
  const onFatalErrorRef = useRef(onFatalError);
  useEffect(() => {
    onFatalErrorRef.current = onFatalError;
  }, [onFatalError]);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else containerRef.current.requestFullscreen().catch(() => {});
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let connected = false;
    let session: WhepSession | null = null;
    const controller = new AbortController();
    setIsLive(false);

    const watchdog = setTimeout(() => {
      if (cancelled || connected) return;
      cancelled = true;
      controller.abort();
      onFatalErrorRef.current();
    }, CONNECT_WATCHDOG_MS);

    const onLoadedData = () => {
      if (cancelled) return;
      connected = true;
      clearTimeout(watchdog);
      setIsLive(true);
      onStatusChangeRef.current?.('online');
      video.play().catch(() => {});
    };
    video.addEventListener('loadeddata', onLoadedData);

    connectWhep(whepUrl, video, controller.signal)
      .then((s) => {
        if (cancelled) {
          s.close();
          return;
        }
        session = s;
      })
      .catch(() => {
        if (cancelled) return;
        cancelled = true;
        clearTimeout(watchdog);
        onFatalErrorRef.current();
      });

    return () => {
      cancelled = true;
      clearTimeout(watchdog);
      controller.abort();
      video.removeEventListener('loadeddata', onLoadedData);
      session?.close();
    };
  }, [whepUrl]);

  return (
    <div ref={containerRef} className="relative w-full h-full bg-black overflow-hidden group">
      <video ref={videoRef} muted playsInline autoPlay className="w-full h-full object-cover" />
      {!isLive && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-ink/90 text-slate-500 gap-2 text-[11px] text-center px-2">
          <RadioTower size={14} className="animate-pulse" />
          Connecting (WebRTC)…
        </div>
      )}
      {isLive && (
        <>
          <span className="absolute top-1.5 left-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/60 text-signal-red text-[10px] font-bold tracking-wide font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-signal-red animate-pulse" />
            LIVE · WEBRTC
          </span>
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'View fullscreen'}
            className="absolute bottom-1.5 right-1.5 p-1.5 rounded bg-black/60 text-slate-200 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity hover:bg-black/80"
          >
            {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
          </button>
        </>
      )}
    </div>
  );
}
