import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchRecordingSegments } from '@/services/recordingsService';

describe('recordingsService.fetchRecordingSegments', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns the availability payload on success', async () => {
    const payload = {
      available: true,
      segments: [{ start: '2026-09-05T08:00:00Z', duration: 600, url: 'https://playback.example/get?token=abc' }],
    };
    (fetch as any).mockResolvedValue({ ok: true, json: async () => payload });
    const result = await fetchRecordingSegments(1);
    expect(result).toEqual(payload);
    expect((fetch as any).mock.calls[0][0]).not.toContain('?');
  });

  it('appends start/end query params when a range is given', async () => {
    (fetch as any).mockResolvedValue({ ok: true, json: async () => ({ available: false, segments: [], service_reachable: true }) });
    await fetchRecordingSegments(1, { start: '2026-09-05T00:00:00.000Z', end: '2026-09-06T00:00:00.000Z' });
    const url = (fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('start=2026-09-05T00%3A00%3A00.000Z');
    expect(url).toContain('end=2026-09-06T00%3A00%3A00.000Z');
  });

  it('throws on a non-ok response', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchRecordingSegments(1)).rejects.toThrow('HTTP 500');
  });
});
