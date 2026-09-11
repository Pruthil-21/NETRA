import { describe, it, expect, vi, beforeEach } from 'vitest';
import { areasService } from '@/services/areasService';

const AREA = {
  id: 1, name: 'APC Area', village_id: 100, village: 'APC', taluka: 'Anand', district: 'Anand',
  district_id: 1, created_at: '2026-01-01T00:00:00Z',
};

describe('areasService', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('listAreas fetches and returns areas', async () => {
    (fetch as any).mockResolvedValue({ ok: true, json: async () => [AREA] });
    const result = await areasService.listAreas();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('APC Area');
  });

  it('listAreas passes villageId/search as query params', async () => {
    (fetch as any).mockResolvedValue({ ok: true, json: async () => [AREA] });
    await areasService.listAreas({ villageId: 100, search: 'apc' });
    const [url] = (fetch as any).mock.calls[0];
    expect(url).toContain('village_id=100');
    expect(url).toContain('search=apc');
  });

  it('createArea posts the body and returns the created area', async () => {
    (fetch as any).mockResolvedValue({ ok: true, json: async () => ({ ...AREA, id: 2, name: 'New Area' }) });
    const result = await areasService.createArea({ name: 'New Area', village_id: 100 });
    expect(result.id).toBe(2);
    const [, options] = (fetch as any).mock.calls[0];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ name: 'New Area', village_id: 100 });
  });

  it('deleteArea throws on a non-ok response', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 400 });
    await expect(areasService.deleteArea(1)).rejects.toThrow('HTTP 400');
  });
});
