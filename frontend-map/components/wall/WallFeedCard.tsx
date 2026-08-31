'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Camera } from '@/types/camera';
import { getCameraStreamUrl } from '@/lib/stream';
import CameraLivePlayer from '@/components/registry/CameraLivePlayer';

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
export function WallFeedCard({ camera }: { camera: Camera }) {
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

  return (
    <div className="bg-panel border border-line rounded overflow-hidden flex flex-col">
      <div className="px-3 py-2 border-b border-line flex items-center justify-between gap-2 bg-panel-raised">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold text-white truncate">{camera.name}</h3>
          <p className="text-[10px] text-slate-500 truncate">{camera.dept}</p>
        </div>
        <span className="text-[10px] font-mono text-slate-600 shrink-0">#{camera.id}</span>
      </div>
      <div ref={containerRef} className="relative aspect-video w-full bg-black">
        {hasBeenVisible ? (
          <CameraLivePlayer
            camera={camera}
            hlsSrc={stream.url}
            hlsUnavailableReason={stream.reason}
          />
        ) : (
          <div className="w-full h-full" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

export default WallFeedCard;
