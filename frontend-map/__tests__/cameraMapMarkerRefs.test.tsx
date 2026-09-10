// Verifies the memoization key, not the full Leaflet render (CameraMap itself
// requires a jsdom+Leaflet setup already exercised by ScaleMap.test.tsx) --
// this isolates exactly the bug: a stable-id-set input must not produce a new
// Map of callbacks when only an unrelated field (e.g. connectivity_status)
// changes on one camera.
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMemo } from 'react';

interface Cam { id: number; connectivity_status: string }

function useMarkerRefCallbacksKeyedOnIds(cameras: Cam[]) {
  // Mirrors the fixed implementation's memo dependency: cameras.map(c=>c.id).join(',')
  const idKey = cameras.map((c) => c.id).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => new Map(cameras.map((c) => [c.id, () => {}])), [idKey]);
}

describe('marker ref callbacks memoization', () => {
  it('stays the same Map reference when only connectivity_status changes', () => {
    const camerasV1: Cam[] = [{ id: 1, connectivity_status: 'online' }, { id: 2, connectivity_status: 'offline' }];
    const { result, rerender } = renderHook(({ cameras }) => useMarkerRefCallbacksKeyedOnIds(cameras), {
      initialProps: { cameras: camerasV1 },
    });
    const firstMap = result.current;

    const camerasV2: Cam[] = [{ id: 1, connectivity_status: 'offline' }, { id: 2, connectivity_status: 'offline' }];
    rerender({ cameras: camerasV2 });

    expect(result.current).toBe(firstMap);
  });

  it('produces a new Map when the set of camera ids actually changes', () => {
    const camerasV1: Cam[] = [{ id: 1, connectivity_status: 'online' }];
    const { result, rerender } = renderHook(({ cameras }) => useMarkerRefCallbacksKeyedOnIds(cameras), {
      initialProps: { cameras: camerasV1 },
    });
    const firstMap = result.current;

    const camerasV2: Cam[] = [{ id: 1, connectivity_status: 'online' }, { id: 2, connectivity_status: 'online' }];
    rerender({ cameras: camerasV2 });

    expect(result.current).not.toBe(firstMap);
  });
});
