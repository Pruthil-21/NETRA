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

// MediaMTX's cookieCheck redirect can hang indefinitely on a dead stream
// (the request never resolves, so hls.js never sees a fatal error to react
// to). This watchdog guarantees we still reach a terminal state instead of
// sitting on "Connecting…" forever.
const CONNECT_WATCHDOG_MS = 12000;

// hls.js firing MANIFEST_PARSED only means the playlist was readable — on a
// flaky LL-HLS source (part requests 503ing) no actual frame data may ever
// arrive, leaving the video element stuck at readyState 0 while we claim
// "Live". If no real frame shows up shortly after, treat it as a failure.
const PLAYBACK_STALL_MS = 8000;

// The organizer's upstream cameras are highly dynamic — a publisher can drop
// and come back within 10-30s. Once a camera settles into a terminal offline
// state, keep quietly re-checking in the background so a recovered feed
// starts playing on its own instead of requiring a manual Retry click.
const AUTO_RETRY_INTERVAL_MS = 15000;

export default function LiveFeedPlayer({
  src,
  unavailableReason,
  preliminaryStatus,
  onStatusChange,
}: {
  src: string | null;
  unavailableReason?: StreamUnavailableReason;
  preliminaryStatus?: ConnectivityStatus;
  onStatusChange?: (status: ConnectivityStatus) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [status, setStatus] = useState<FeedStatus>('checking');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  // Kept in a ref so the connection effect below doesn't need this in its
  // dependency array — an inline arrow function from the parent would
  // otherwise re-run the whole connection attempt on every parent render.
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  const terminalStatus: FeedStatus = preliminaryStatus === 'online' ? 'unavailable' : 'offline';
  const terminalMessage =
    terminalStatus === 'offline' ? 'Camera currently offline' : 'Stream temporarily unavailable';

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!src || (status !== 'offline' && status !== 'unavailable')) return;
    const timer = setTimeout(() => setRetryNonce((n) => n + 1), AUTO_RETRY_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [src, status]);

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
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    setStatus('checking');

    const clearRetryTimer = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const clearWatchdog = () => {
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
    };

    const clearStallTimer = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };

    const giveUp = () => {
      clearRetryTimer();
      clearWatchdog();
      clearStallTimer();
      setStatus(terminalStatus);
      onStatusChangeRef.current?.('offline');
    };

    watchdogTimer = setTimeout(() => {
      if (!cancelled) giveUp();
    }, CONNECT_WATCHDOG_MS);

    const scheduleRetry = (recover: () => void) => {
      clearStallTimer();
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

    const armStallWatch = (recover: () => void) => {
      clearStallTimer();
      stallTimer = setTimeout(() => {
        if (cancelled) return;
        if (video.readyState < 2) scheduleRetry(recover);
      }, PLAYBACK_STALL_MS);
    };

    // loadeddata is the actual proof of a decoded frame — more reliable than
    // MANIFEST_PARSED (which can fire on a flaky source that never delivers
    // real media, see PLAYBACK_STALL_MS above), so this is what we report
    // upstream as the camera's real connectivity for the map pin.
    const onFirstFrame = () => {
      clearStallTimer();
      onStatusChangeRef.current?.('online');
    };
    video.addEventListener('loadeddata', onFirstFrame);

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
          clearWatchdog();
          setStatus('live');
          video.play().catch(() => {});
          armStallWatch(() => hls.startLoad());
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
            clearWatchdog();
            setStatus('live');
            video.play().catch(() => {});
            armStallWatch(() => {
              video.src = src;
            });
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
      clearWatchdog();
      clearStallTimer();
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (video) {
        video.removeEventListener('loadeddata', onFirstFrame);
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
