import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useScaleMetrics } from '@/hooks/useScaleMetrics';
import { scaleCameraService } from '@/services/scaleCameraService';

describe('useScaleMetrics', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cameras: [], next_cursor: null }) }));
  });

  it('counts every real API request via onScaleApiRequest, not just manual calls', async () => {
    const { result } = renderHook(() => useScaleMetrics());
    act(() => result.current.recordApiRequest()); // e.g. the page's own health check

    // Simulate scaleCameraService making two real calls, the way ScaleMap/
    // ScaleSummaryCard/ScaleCameraList actually do -- the hook must react to
    // these without anything explicitly calling recordApiRequest for them.
    await act(async () => {
      await scaleCameraService.listPage();
      await scaleCameraService.listPage();
    });

    expect(result.current.apiRequestCount).toBe(3);
  });

  it('records interaction timings', () => {
    const { result } = renderHook(() => useScaleMetrics());
    act(() => result.current.recordInteraction('map-pan', 42));
    expect(result.current.interactions).toEqual([{ label: 'map-pan', durationMs: 42 }]);
  });

  it('sets initialLoadMs on the first real API request, not immediately on mount', async () => {
    const { result } = renderHook(() => useScaleMetrics());
    expect(result.current.initialLoadMs).toBeNull(); // nothing has loaded yet
    act(() => result.current.recordApiRequest());
    await waitFor(() => expect(result.current.initialLoadMs).not.toBeNull());
    expect(typeof result.current.initialLoadMs).toBe('number');
  });
});
