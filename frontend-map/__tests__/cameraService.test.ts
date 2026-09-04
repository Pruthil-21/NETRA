import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cameraService } from '@/services/cameraService';

describe('cameraService.updateCameraCircle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('PUTs circle_id to the registry API and returns the updated camera', async () => {
    const updatedCamera = { id: 12, name: 'Cam', dept: 'Anand', circle_id: 3 };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => updatedCamera });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await cameraService.updateCameraCircle(12, 3);

    expect(result).toEqual(updatedCamera);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain('/cameras/12');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ circle_id: 3 });
  });

  it('sends circle_id: null to clear an assignment', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 12, circle_id: null }) });
    vi.stubGlobal('fetch', fetchSpy);

    await cameraService.updateCameraCircle(12, null);

    const [, options] = fetchSpy.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ circle_id: null });
  });

  it('surfaces the backend\'s own detail message on rejection (e.g. cross-district)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ detail: 'Circle belongs to a different district than this camera' }),
      })
    );

    await expect(cameraService.updateCameraCircle(12, 3)).rejects.toThrow(
      'Circle belongs to a different district than this camera'
    );
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    }));

    await expect(cameraService.updateCameraCircle(12, 3)).rejects.toThrow(/HTTP 500/);
  });
});
