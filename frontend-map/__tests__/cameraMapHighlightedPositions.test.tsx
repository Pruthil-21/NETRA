// Verifies the memoization key behind CameraMap's highlightedPositions memo,
// not the full Leaflet render (see cameraMapMarkerRefs.test.tsx for the same
// pattern applied to markerRefCallbacks). Isolates the exact bug: a tree
// selection's highlighted camera ids/positions must not produce a new
// highlightedPositions array reference when an unrelated camera's field
// (e.g. connectivity_status) changes -- MapController's bounds-fit effect
// depends on that array reference and calls map.flyToBounds(...) whenever it
// changes, yanking the viewport back to the tree selection on every
// connectivity flip if this isn't memoized correctly.
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMemo } from 'react';

interface Cam { id: number; lat: number; long: number; connectivity_status: string }

function useHighlightedPositions(cameras: Cam[], highlightedIds: Set<number>) {
  const highlightedIdsKey = Array.from(highlightedIds).sort((a, b) => a - b).join(',');
  // Mirrors the fixed implementation in CameraMap.tsx
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const highlightedPositionsKey = useMemo(() => {
    if (highlightedIds.size === 0) return '';
    return cameras
      .filter((cam) => highlightedIds.has(cam.id))
      .map((cam) => `${cam.lat},${cam.long ?? 0}`)
      .join('|');
  }, [cameras, highlightedIdsKey]);

  return useMemo(() => {
    if (!highlightedPositionsKey) return [];
    return highlightedPositionsKey.split('|').map((pair) => {
      const [lat, long] = pair.split(',').map(Number);
      return [lat, long] as [number, number];
    });
  }, [highlightedPositionsKey]);
}

describe('CameraMap highlightedPositions memoization', () => {
  it('stays the same array reference when only an unrelated camera\'s connectivity_status changes', () => {
    const highlighted = new Set([1]);
    const camerasV1: Cam[] = [
      { id: 1, lat: 22.5, long: 72.9, connectivity_status: 'online' },
      { id: 2, lat: 23.0, long: 72.5, connectivity_status: 'online' },
    ];
    const { result, rerender } = renderHook(
      ({ cameras }) => useHighlightedPositions(cameras, highlighted),
      { initialProps: { cameras: camerasV1 } }
    );
    const first = result.current;

    // Same lat/long for the highlighted camera (id 1), only camera 2 (not
    // highlighted) flips status -- a brand-new `cameras` array reference,
    // same as every real health-check tick produces.
    const camerasV2: Cam[] = [
      { id: 1, lat: 22.5, long: 72.9, connectivity_status: 'online' },
      { id: 2, lat: 23.0, long: 72.5, connectivity_status: 'offline' },
    ];
    rerender({ cameras: camerasV2 });

    expect(result.current).toBe(first);
  });

  it('produces a new array when a highlighted camera\'s position actually changes', () => {
    const highlighted = new Set([1]);
    const camerasV1: Cam[] = [{ id: 1, lat: 22.5, long: 72.9, connectivity_status: 'online' }];
    const { result, rerender } = renderHook(
      ({ cameras }) => useHighlightedPositions(cameras, highlighted),
      { initialProps: { cameras: camerasV1 } }
    );
    const first = result.current;

    const camerasV2: Cam[] = [{ id: 1, lat: 22.6, long: 72.9, connectivity_status: 'online' }];
    rerender({ cameras: camerasV2 });

    expect(result.current).not.toBe(first);
    expect(result.current).toEqual([[22.6, 72.9]]);
  });
});
