'use client';

import React, { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { AlertTriangle, Maximize, Minimize, RadioTower, VideoOff } from 'lucide-react';
import type { ConnectivityStatus } from '@/types/camera';
import type { StreamUnavailableReason } from '@/lib/stream';

type FeedStatus = 'checking' | 'connecting' | 'live' | 'offline' | 'unavailable';

const CONFIG_ERROR_MESSAGES: Record<StreamUnavailableReason | 'unknown', string> = {
  'not-configured': 'Streaming not configured',
  'no-stream': 'No live feed for this camera',
  unknown: 'Stream temporarily unavailable',
};

// The organizer's width>0 flag is only a preliminary signal — a fatal hls.js
// error gets a couple of quick automatic retries (transient upstream blips
// self-heal fast), but we never retry forever. Once exhausted, the camera
// needs a manual Retry click.
const MAX_AUTO_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;

export default function LiveFeedPlayer({
  src,
  unavailableReason,
  preliminaryStatus,
}: {
  src: string | null;
  unavailableReason?: StreamUnavailableReason;
  preliminaryStatus?: ConnectivityStatus;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [status, setStatus] = useState<FeedStatus>('checking');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  const terminalStatus: FeedStatus = preliminaryStatus === 'online' ? 'unavailable' : 'offline';
  const terminalMessage =
    terminalStatus === 'offline' ? 'Camera currently offline' : 'Stream temporarily unavailable';

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
      setStatus('offline');
      return;
    }

    let cancelled = false;
    let onReady: (() => void) | null = null;
    let onNativeError: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    setStatus('checking');

    const clearRetryTimer = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const giveUp = () => {
      clearRetryTimer();
      setStatus(terminalStatus);
    };

    const scheduleRetry = (recover: () => void) => {
      if (attempt >= MAX_AUTO_RETRIES) {
        giveUp();
        return;
      }
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      attempt += 1;
      setStatus('connecting');
      clearRetryTimer();
      retryTimer = setTimeout(() => {
        if (!cancelled) recover();
      }, delay);
    };

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
          attempt = 0;
          clearRetryTimer();
          setStatus('live');
          video.play().catch(() => {});
        });
        hls.on(HlsLib.Events.ERROR, (_event, data) => {
          if (cancelled || !data.fatal) return;
          switch (data.type) {
            case HlsLib.ErrorTypes.NETWORK_ERROR:
              scheduleRetry(() => hls.startLoad());
              break;
            case HlsLib.ErrorTypes.MEDIA_ERROR:
              scheduleRetry(() => hls.recoverMediaError());
              break;
            default:
              giveUp();
              break;
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari plays HLS natively without hls.js, and has no equivalent
        // recover-in-place API, so retry by reassigning the source.
        onReady = () => {
          if (!cancelled) {
            attempt = 0;
            clearRetryTimer();
            setStatus('live');
            video.play().catch(() => {});
          }
        };
        onNativeError = () => {
          if (!cancelled) {
            scheduleRetry(() => {
              video.src = src;
            });
          }
        };
        video.addEventListener('loadedmetadata', onReady);
        video.addEventListener('error', onNativeError);
        video.src = src;
      } else {
        giveUp();
      }
    });

    return () => {
      cancelled = true;
      clearRetryTimer();
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (video) {
        if (onReady) video.removeEventListener('loadedmetadata', onReady);
        if (onNativeError) video.removeEventListener('error', onNativeError);
        video.removeAttribute('src');
      }
    };
  }, [src, retryNonce, terminalStatus]);

  if (!src) {
    return (
      <div className="flex items-center justify-center h-full w-full bg-slate-950 text-slate-600 gap-2 text-[11px] text-center px-2">
        <VideoOff size={14} />
        {CONFIG_ERROR_MESSAGES[unavailableReason ?? 'unknown']}
      </div>
    );
  }

  const isTerminal = status === 'offline' || status === 'unavailable';

  return (
    <div ref={containerRef} className="relative w-full h-full bg-black overflow-hidden group">
      <video ref={videoRef} muted playsInline autoPlay className="w-full h-full object-cover" />
      {status !== 'live' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/90 text-slate-500 gap-2 text-[11px] text-center px-2">
          {isTerminal ? (
            <>
              <AlertTriangle size={14} />
              {terminalMessage}
              <button
                type="button"
                onClick={() => setRetryNonce((n) => n + 1)}
                className="mt-1 text-[11px] px-2.5 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200 hover:text-white"
              >
                Retry
              </button>
            </>
          ) : (
            <>
              <RadioTower size={14} className="animate-pulse" />
              {status === 'checking' ? 'Checking camera…' : 'Connecting to live feed…'}
            </>
          )}
        </div>
      )}
      {status === 'live' && (
        <>
          <span className="absolute top-1.5 left-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/60 text-rose-400 text-[10px] font-bold tracking-wide">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
            LIVE
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
