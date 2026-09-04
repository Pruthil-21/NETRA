import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scaleCameraService, onScaleApiRequest } from '@/services/scaleCameraService';

describe('scaleCameraService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('listPage requests include_synthetic=true and passes cursor/limit through', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ cameras: [], next_cursor: 42 }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await scaleCameraService.listPage({ cursor: 10, limit: 50 });

    expect(result.next_cursor).toBe(42);
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('include_synthetic=true');
    expect(calledUrl).toContain('cursor=10');
    expect(calledUrl).toContain('limit=50');
  });

  it('listPage includes bbox params when given', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cameras: [], next_cursor: null }) });
    vi.stubGlobal('fetch', fetchSpy);

    await scaleCameraService.listPage({ bbox: { minLat: 20, maxLat: 24, minLong: 68, maxLong: 74 } });

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('min_lat=20');
    expect(calledUrl).toContain('max_lat=24');
    expect(calledUrl).toContain('min_long=68');
    expect(calledUrl).toContain('max_long=74');
  });

  it('getSummary returns the parsed summary', async () => {
    const summary = { total: 80030, online: 68000, degraded: 8000, offline: 4030, real_stream_count: 30, synthetic_count: 80000, edge_node_count: 800 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => summary }));

    const result = await scaleCameraService.getSummary();
    expect(result).toEqual(summary);
  });

  it('throws a descriptive error on a failed response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(scaleCameraService.getSummary()).rejects.toThrow(/500/);
  });

  it('getDistrictSummary requests group_by=district with the given bbox', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ districts: [{ district: 'Ahmedabad', count: 12000 }] }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await scaleCameraService.getDistrictSummary({ minLat: 20, maxLat: 24, minLong: 68, maxLong: 74 });

    expect(result).toEqual([{ district: 'Ahmedabad', count: 12000 }]);
    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('group_by=district');
    expect(calledUrl).toContain('min_lat=20');
  });

  it('notifies onScaleApiRequest listeners exactly once per real fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cameras: [], next_cursor: null }) }));
    const listener = vi.fn();
    const unsubscribe = onScaleApiRequest(listener);

    await scaleCameraService.listPage();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await scaleCameraService.listPage();
    expect(listener).toHaveBeenCalledTimes(1); // not called again after unsubscribing
  });
});
