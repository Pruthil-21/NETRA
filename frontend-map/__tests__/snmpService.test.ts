import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCameraHealth } from '@/services/snmpService';

describe('snmpService.getCameraHealth', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns the device when the backend has one', async () => {
    const device = { id: 'cam01', name: 'cam01', status: 'online', reachable: true, snmp_mode: 'mock', snmp_state: 'simulated', metrics: { cpu_percent: 20, memory_percent: 30, network_mbps: 5, temperature_celsius: 40 }, last_checked_at: '2026-09-05T00:00:00Z' };
    (fetch as any).mockResolvedValue({ ok: true, status: 200, json: async () => device });
    const result = await getCameraHealth(1);
    expect(result).toEqual(device);
  });

  it('returns null on a 404 (monitor down or no matching device) instead of throwing', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 404 });
    const result = await getCameraHealth(999);
    expect(result).toBeNull();
  });

  it('throws on other failures', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 500 });
    await expect(getCameraHealth(1)).rejects.toThrow('HTTP 500');
  });
});
