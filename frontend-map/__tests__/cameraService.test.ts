import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cameraService } from '@/services/cameraService';

describe('cameraService.updateCamera', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('PUTs the given patch to the registry API and returns the updated camera', async () => {
    const updatedCamera = { id: 12, name: 'Renamed Cam', dept: 'Anand' };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => updatedCamera });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await cameraService.updateCamera(12, { name: 'Renamed Cam' });

    expect(result).toEqual(updatedCamera);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain('/cameras/12');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body)).toEqual({ name: 'Renamed Cam' });
  });

  it('surfaces the backend\'s own detail message on rejection (e.g. cross-district)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ detail: 'Area belongs to a different district than this camera' }),
      })
    );

    await expect(cameraService.updateCamera(12, { area_id: 3 })).rejects.toThrow(
      'Area belongs to a different district than this camera'
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

    await expect(cameraService.updateCamera(12, { name: 'x' })).rejects.toThrow(/HTTP 500/);
  });
});

describe('cameraService.deleteCamera', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('DELETEs the camera from the registry API', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    await cameraService.deleteCamera(12);

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain('/cameras/12');
    expect(options.method).toBe('DELETE');
  });

  it('surfaces the backend\'s own detail message on rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ detail: 'Camera has active recordings' }),
      })
    );

    await expect(cameraService.deleteCamera(12)).rejects.toThrow('Camera has active recordings');
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    }));

    await expect(cameraService.deleteCamera(12)).rejects.toThrow(/HTTP 500/);
  });
});
