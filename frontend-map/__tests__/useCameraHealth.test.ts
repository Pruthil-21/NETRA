import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCameraHealth } from '@/hooks/useCameraHealth';

describe('useCameraHealth', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('stays null when no camera is selected', async () => {
    const { result } = renderHook(() => useCameraHealth(null));
    expect(result.current.device).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('fetches and exposes the device for a selected camera', async () => {
    const device = { id: 'cam01', name: 'cam01', status: 'online', reachable: true, snmp_mode: 'mock', snmp_state: 'simulated', metrics: null, last_checked_at: '2026-09-05T00:00:00Z' };
    (fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => device });
    const { result } = renderHook(() => useCameraHealth(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.device).toEqual(device);
  });

  it('leaves device null when the backend has nothing for this camera', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 404 });
    const { result } = renderHook(() => useCameraHealth(999));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.device).toBeNull();
  });
});
