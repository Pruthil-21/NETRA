'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, Camera as CameraIcon } from 'lucide-react';
import { scaleCameraService } from '@/services/scaleCameraService';
import { ScaleCamera } from '@/types/scaleCamera';

const ROW_HEIGHT_PX = 56;
const PAGE_SIZE = 200;
// Start loading the next page once the visible range is within this many
// rows of the end of what's currently loaded -- loads slightly ahead of
// the scroll position instead of only once the user hits the literal bottom.
const LOAD_MORE_THRESHOLD_ROWS = 20;

interface ScaleCameraListProps {
  onSelectCamera: (camera: ScaleCamera) => void;
  /** Test-only hook: called with the component's loadMore function once
   * available, so a test can trigger pagination directly instead of trying
   * to simulate real scroll physics jsdom doesn't have. Never passed by
   * the real page (Task 12). */
  onLoadMoreReady?: (loadMore: () => void) => void;
}

export function ScaleCameraList({ onSelectCamera, onLoadMoreReady }: ScaleCameraListProps) {
  const [cameras, setCameras] = useState<ScaleCamera[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadingMoreRef = useRef(false);
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scaleCameraService
      .listPage({ limit: PAGE_SIZE })
      .then((page) => {
        setCameras(page.cameras);
        setNextCursor(page.next_cursor);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load cameras'))
      .finally(() => setLoading(false));
  }, []);

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current || nextCursor === null) return;
    loadingMoreRef.current = true;
    scaleCameraService
      .listPage({ cursor: nextCursor, limit: PAGE_SIZE })
      .then((page) => {
        setCameras((prev) => [...prev, ...page.cameras]);
        setNextCursor(page.next_cursor);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load more cameras'))
      .finally(() => {
        loadingMoreRef.current = false;
      });
  }, [nextCursor]);

  useEffect(() => {
    onLoadMoreReady?.(loadMore);
  }, [onLoadMoreReady, loadMore]);

  const virtualizer = useVirtualizer({
    count: cameras.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 10,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const lastVisibleIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;
  useEffect(() => {
    if (lastVisibleIndex >= cameras.length - LOAD_MORE_THRESHOLD_ROWS) {
      loadMore();
    }
  }, [lastVisibleIndex, cameras.length, loadMore]);

  if (loading) {
    return <div className="animate-pulse h-64 bg-panel-raised rounded" aria-label="Loading cameras" />;
  }

  if (error && cameras.length === 0) {
    return (
      <div className="flex items-center gap-2.5 p-4 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red text-xs">
        <AlertTriangle size={16} />
        Failed to load cameras — {error}
      </div>
    );
  }

  if (cameras.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-slate-500">
        <CameraIcon size={24} className="text-slate-600" />
        <p className="text-xs">No cameras in this page.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {error && (
        <div className="flex items-center gap-2 px-3 py-1.5 mb-1 rounded border border-signal-red/30 bg-signal-red/10 text-signal-red text-[10px] shrink-0">
          <AlertTriangle size={12} />
          Failed to load more cameras — {error}
        </div>
      )}
      <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto border border-line rounded-lg bg-panel">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualItems.map((virtualRow) => {
          const camera = cameras[virtualRow.index];
          return (
            <button
              key={camera.id}
              onClick={() => onSelectCamera(camera)}
              className="absolute left-0 top-0 w-full flex items-center justify-between px-3 text-left text-xs text-slate-300 hover:bg-panel-raised border-b border-line"
              style={{ height: ROW_HEIGHT_PX, transform: `translateY(${virtualRow.start}px)` }}
            >
              <div className="min-w-0">
                <p className="font-mono truncate">{camera.name}</p>
                <p className="text-[10px] text-slate-500">{camera.dept}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {camera.is_synthetic && (
                  <span className="text-[8px] uppercase font-bold px-1 py-0.5 rounded bg-slate-700/50 text-slate-400">
                    Synthetic
                  </span>
                )}
                <span
                  className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded ${
                    camera.connectivity_status === 'online'
                      ? 'text-signal-green'
                      : camera.connectivity_status === 'degraded'
                        ? 'text-signal-amber'
                        : 'text-signal-red'
                  }`}
                >
                  {camera.connectivity_status}
                </span>
              </div>
            </button>
          );
        })}
      </div>
      </div>
    </div>
  );
}
