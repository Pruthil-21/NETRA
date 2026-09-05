import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchRecordingSegments } from '@/services/recordingsService';

describe('recordingsService.fetchRecordingSegments', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns the availability payload on success', async () => {
    const payload = { available: true, segments: [{ start: '2026-09-05T08:00:00Z', duration: 600 }] };
    (fetch as any).mockResolvedValue({ ok: true, json: async () => payload });
    const result = await fetchRecordingSegments(1);
    expect(result).toEqual(payload);
  });

  it('throws on a non-ok response', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchRecordingSegments(1)).rejects.toThrow('HTTP 500');
  });
});
