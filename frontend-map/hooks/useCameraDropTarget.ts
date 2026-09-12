'use client';

import { useCallback, useState } from 'react';
import type { DragEvent } from 'react';
import { CAMERA_DRAG_MIME } from '@/lib/cameraDrag';

/** Shared drop-target wiring for "drag camera(s) out of DistrictAreaTree,
 * drop them onto a grid to start watching" -- used by both the Dashboard's
 * live CameraGrid and Archive's recorded-footage grid, so the two grids
 * can't drift apart in drag/drop behavior. `isOver` is for the caller's own
 * visual drop-zone highlight; the actual payload parsing/validation lives
 * here once instead of twice. */
export function useCameraDropTarget(onDrop: (cameraIds: number[]) => void) {
  const [isOver, setIsOver] = useState(false);

  const handleDragOver = useCallback((e: DragEvent<Element>) => {
    if (!e.dataTransfer.types.includes(CAMERA_DRAG_MIME)) return;
    e.preventDefault();
    setIsOver(true);
  }, []);

  const handleDragLeave = useCallback(() => setIsOver(false), []);

  const handleDrop = useCallback(
    (e: DragEvent<Element>) => {
      const raw = e.dataTransfer.getData(CAMERA_DRAG_MIME);
      setIsOver(false);
      if (!raw) return;
      e.preventDefault();
      try {
        const parsed = JSON.parse(raw);
        const ids = Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : [];
        if (ids.length > 0) onDrop(ids);
      } catch {
        // Malformed payload -- ignore, nothing was dropped. Never thrown by
        // our own startCameraDrag, but a drop target shouldn't crash on a
        // drag it doesn't recognize (e.g. a stray OS file drag).
      }
    },
    [onDrop]
  );

  return {
    isOver,
    dropHandlers: { onDragOver: handleDragOver, onDragLeave: handleDragLeave, onDrop: handleDrop },
  };
}
