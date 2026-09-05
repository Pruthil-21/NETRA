import { describe, it, expect, vi, beforeEach } from 'vitest';
import { circlesService } from '@/services/circlesService';

describe('circlesService', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('listCircles fetches and returns circles', async () => {
    (fetch as any).mockResolvedValue({ ok: true, json: async () => [{ id: 1, name: 'APC Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' }] });
    const result = await circlesService.listCircles();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('APC Circle');
  });

  it('createCircle posts the body and returns the created circle', async () => {
    (fetch as any).mockResolvedValue({ ok: true, json: async () => ({ id: 2, name: 'New Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' }) });
    const result = await circlesService.createCircle({ name: 'New Circle', district: 'Anand' });
    expect(result.id).toBe(2);
    const [, options] = (fetch as any).mock.calls[0];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ name: 'New Circle', district: 'Anand' });
  });

  it('deleteCircle throws on a non-ok response', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 400 });
    await expect(circlesService.deleteCircle(1)).rejects.toThrow('HTTP 400');
  });
});
