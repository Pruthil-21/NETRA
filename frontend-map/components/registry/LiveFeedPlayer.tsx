'use client';

import React, { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import { AlertTriangle, Maximize, Minimize, RadioTower, VideoOff } from 'lucide-react';
import type { StreamUnavailableReason } from '@/lib/stream';

type FeedStatus = 'connecting' | 'live' | 'reconnecting' | 'error';
type ErrorReason = StreamUnavailableReason | 'network' | 'unsupported' | 'unknown';

const ERROR_MESSAGES: Record<ErrorReason, string> = {
  'not-configured': 'Streaming not configured',
  'no-stream': 'No live feed for this camera',
  network: 'Feed unavailable',
  unsupported: 'Playback not supported in this browser',
  unknown: 'Feed unavailable',
};

// Upstream camera links (Corp8 -> FFmpeg -> MediaMTX) drop and reconnect on their
// own; a dropped fragment/manifest load is a fatal hls.js error but not a dead
// camera, so retry with backoff instead of surfacing a hard error immediately.
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 10000;

export default function LiveFeedPlayer({
  src,
  unavailableReason,
}: {
  src: string | null;
  unavailableReason?: StreamUnavailableReason;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const [errorReason, setErrorReason] = useState<ErrorReason>('unknown');
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
      setErrorReason(unavailableReason ?? 'unknown');
      return;
    }

    let cancelled = false;
    let onReady: (() => void) | null = null;
    let onNativeError: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryAttempt = 0;
    setStatus('connecting');

    const clearRetryTimer = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const scheduleRetry = (recover: () => void) => {
      clearRetryTimer();
      const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** retryAttempt, RETRY_MAX_DELAY_MS);
      retryAttempt += 1;
      retryTimer = setTimeout(() => {
        if (!cancelled) recover();
      }, delay);
    };

    import('hls.js').then(({ default: HlsLib }) => {
      if (cancelled || !video) return;

      if (HlsLib.isSupported()) {
        const hls = new HlsLib({ maxBufferLength: 10, liveSyncDurationCount: 3 });
        hlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(HlsLib.Events.MANIFEST_PARSED, () => {
          if (cancelled) return;
          retryAttempt = 0;
          clearRetryTimer();
          setStatus('live');
          video.play().catch(() => {});
        });
        hls.on(HlsLib.Events.ERROR, (_event, data) => {
          if (cancelled || !data.fatal) return;
          switch (data.type) {
            case HlsLib.ErrorTypes.NETWORK_ERROR:
              setStatus('reconnecting');
              scheduleRetry(() => hls.startLoad());
              break;
            case HlsLib.ErrorTypes.MEDIA_ERROR:
              setStatus('reconnecting');
              scheduleRetry(() => hls.recoverMediaError());
              break;
            default:
              setStatus('error');
              setErrorReason('network');
              break;
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari plays HLS natively without hls.js, and has no equivalent
        // recover-in-place API, so retry by reassigning the source.
        onReady = () => {
          if (!cancelled) {
            retryAttempt = 0;
            clearRetryTimer();
            setStatus('live');
            video.play().catch(() => {});
          }
        };
        onNativeError = () => {
          if (!cancelled) {
            setStatus('reconnecting');
            scheduleRetry(() => {
              video.src = src;
            });
          }
        };
        video.addEventListener('loadedmetadata', onReady);
        video.addEventListener('error', onNativeError);
        video.src = src;
      } else {
        setStatus('error');
        setErrorReason('unsupported');
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
  }, [src, unavailableReason]);

  if (!src) {
    return (
      <div className="flex items-center justify-center h-full w-full bg-slate-950 text-slate-600 gap-2 text-[11px] text-center px-2">
        <VideoOff size={14} />
        {ERROR_MESSAGES[unavailableReason ?? 'unknown']}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full h-full bg-black overflow-hidden group">
      <video ref={videoRef} muted playsInline autoPlay className="w-full h-full object-cover" />
      {status !== 'live' && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/90 text-slate-500 gap-2 text-[11px] text-center px-2">
          {status === 'error' ? (
            <>
              <AlertTriangle size={14} />
              {ERROR_MESSAGES[errorReason]}
            </>
          ) : (
            <>
              <RadioTower size={14} className="animate-pulse" />
              {status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
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
