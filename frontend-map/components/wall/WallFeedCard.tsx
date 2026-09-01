'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Play } from 'lucide-react';
import { Camera } from '@/types/camera';
import { getCameraStreamUrl } from '@/lib/stream';
import CameraLivePlayer from '@/components/registry/CameraLivePlayer';

// Same hold-to-preview delay as the map popup's hover preview -- one
// consistent "how long before video starts" rule across the whole app.
const HOVER_PLAY_DELAY_MS = 2000;

/** One tile in the Video Wall. Uses CameraLivePlayer (WebRTC-first, HLS
 * fallback) -- the same player CameraDetailDrawer uses for a single
 * selected camera. This *was* HLS-only (LiveFeedPlayer directly) to avoid
 * opening one WHEP connection per visible tile, but that made the whole
 * Wall depend on the HLS relay (a Cloudflare tunnel) being up even for
 * cameras that are only ever exposed via WebRTC/Tailscale in practice
 * (confirmed: the vehicle-trace demo cameras showed nothing on the Wall
 * while still playing fine in the single-camera view, because no
 * Cloudflare tunnel was running for that test). The mount-when-visible
 * gating below already bounds how many players exist at once, so the
 * WebRTC-attempt cost this reintroduces is naturally capped to what's on
 * screen, same as the HLS cost already was. */
export function WallFeedCard({
  camera,
  onFocus,
  startPlaying = false,
}: {
  camera: Camera;
  /** Present only when this card should offer a "focus this camera" affordance. */
  onFocus?: () => void;
  /** True for the single camera an officer explicitly focused -- that click
   * already is the "play this" action, so it skips the hover gate below. */
  startPlaying?: boolean;
}) {
  const stream = getCameraStreamUrl(camera);
  const containerRef = useRef<HTMLDivElement>(null);
  // The wall can list 30+ cameras at once, but CSS grid only controls how
  // many *columns* render -- every tile still mounts unless gated like
  // this, which would mean 30+ simultaneous HLS connections on page load.
  // Mounting the real player only once a tile has actually scrolled into
  // view (and leaving it mounted afterwards, so scrolling back and forth
  // doesn't thrash reconnects) keeps that cost proportional to what's
  // actually on screen.
  const [hasBeenVisible, setHasBeenVisible] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || hasBeenVisible) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setHasBeenVisible(true);
      },
      { rootMargin: '200px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasBeenVisible]);

  // Visible-in-viewport is not the same as "actively decoding" -- the streaming
  // relay only reliably holds ~6 concurrent connections, so a tile only spins
  // up its player on a 2s hover-hold or a click, and tears back down when the
  // cursor leaves (except the one deliberately-focused tile, which stays live).
  const [isPlaying, setIsPlaying] = useState(startPlaying);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  const handleMouseEnter = useCallback(() => {
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => setIsPlaying(true), HOVER_PLAY_DELAY_MS);
  }, [clearHoverTimer]);

  const handleMouseLeave = useCallback(() => {
    clearHoverTimer();
    if (!startPlaying) setIsPlaying(false);
  }, [clearHoverTimer, startPlaying]);

  const handleClick = useCallback(() => {
    clearHoverTimer();
    setIsPlaying(true);
  }, [clearHoverTimer]);

  useEffect(() => clearHoverTimer, [clearHoverTimer]);

  return (
    <div className="bg-panel border border-line rounded overflow-hidden flex flex-col">
      <div className="px-3 py-2 border-b border-line flex items-center justify-between gap-2 bg-panel-raised">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold text-white truncate">{camera.name}</h3>
          <p className="text-[10px] text-slate-500 truncate">{camera.dept}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[10px] font-mono text-slate-600">#{camera.id}</span>
          {onFocus && (
            <button
              type="button"
              onClick={onFocus}
              aria-label={`Focus on ${camera.name}`}
              title="Focus this camera"
              className="p-1 rounded bg-panel text-slate-400 hover:bg-line hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
            >
              <Maximize2 size={12} />
            </button>
          )}
        </div>
      </div>
      <div
        ref={containerRef}
        className="relative aspect-video w-full bg-black cursor-pointer"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      >
        {!hasBeenVisible ? (
          <div className="w-full h-full" aria-hidden="true" />
        ) : isPlaying ? (
          <CameraLivePlayer camera={camera} hlsSrc={stream.url} hlsUnavailableReason={stream.reason} />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-slate-600">
            <Play size={20} />
            <span className="text-[10px] text-slate-500">Hover or click to play live feed</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default WallFeedCard;
