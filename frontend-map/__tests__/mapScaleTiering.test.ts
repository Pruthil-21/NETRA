import { describe, it, expect } from 'vitest';
import {
  isCameraInBounds,
  filterCamerasToViewport,
  districtSummaryFor,
  computeScaleTiering,
  SCALE_TIERING_THRESHOLD,
  CLUSTER_ONLY_MIN_ZOOM,
  MAX_VISIBLE_MARKERS,
  ViewportBounds,
} from '@/lib/mapScaleTiering';
import { Camera } from '@/types/camera';

function makeCamera(overrides: Partial<Camera> & { id: number }): Camera {
  return {
    name: `Camera ${overrides.id}`,
    dept: 'Ahmedabad',
    lat: 23.0,
    long: 72.5,
    camera_type: 'PTZ',
    ownership: 'Government',
    connectivity_status: 'online',
    storage_type: 'Cloud',
    retention_days: 30,
    health_status: 'operational',
    rtsp_url: '',
    ...overrides,
  };
}

const GUJARAT_BOUNDS: ViewportBounds = { minLat: 20, maxLat: 24.5, minLong: 68, maxLong: 74.5 };

describe('isCameraInBounds / filterCamerasToViewport', () => {
  it('includes a camera strictly inside the bounds', () => {
    const cam = makeCamera({ id: 1, lat: 23.0, long: 72.5 });
    expect(isCameraInBounds(cam, GUJARAT_BOUNDS)).toBe(true);
  });

  it('excludes a camera outside the bounds', () => {
    const cam = makeCamera({ id: 2, lat: 28.6, long: 77.2 }); // Delhi
    expect(isCameraInBounds(cam, GUJARAT_BOUNDS)).toBe(false);
  });

  it('treats a camera exactly on the boundary as inside (inclusive)', () => {
    const cam = makeCamera({ id: 3, lat: GUJARAT_BOUNDS.maxLat, long: GUJARAT_BOUNDS.maxLong });
    expect(isCameraInBounds(cam, GUJARAT_BOUNDS)).toBe(true);
  });

  it('filters a mixed list down to only in-bounds cameras', () => {
    const cams = [
      makeCamera({ id: 1, lat: 23.0, long: 72.5 }), // in
      makeCamera({ id: 2, lat: 28.6, long: 77.2 }), // out
      makeCamera({ id: 3, lat: 21.5, long: 70.0 }), // in
    ];
    const result = filterCamerasToViewport(cams, GUJARAT_BOUNDS);
    expect(result.map((c) => c.id)).toEqual([1, 3]);
  });
});

describe('districtSummaryFor', () => {
  it('counts cameras per district, sorted descending by count', () => {
    const cams = [
      makeCamera({ id: 1, dept: 'Surat' }),
      makeCamera({ id: 2, dept: 'Ahmedabad' }),
      makeCamera({ id: 3, dept: 'Ahmedabad' }),
      makeCamera({ id: 4, dept: 'Ahmedabad' }),
      makeCamera({ id: 5, dept: 'Surat' }),
    ];
    expect(districtSummaryFor(cams)).toEqual([
      { district: 'Ahmedabad', count: 3 },
      { district: 'Surat', count: 2 },
    ]);
  });

  it('returns an empty list for no cameras', () => {
    expect(districtSummaryFor([])).toEqual([]);
  });
});

describe('computeScaleTiering', () => {
  it('below the threshold, renders every camera untouched and does not tier at all', () => {
    const cams = Array.from({ length: 10 }, (_, i) => makeCamera({ id: i }));
    const result = computeScaleTiering(cams, null, null);
    expect(result.isTiered).toBe(false);
    expect(result.renderableCameras).toBe(cams); // same reference, not a copy/filter
    expect(result.districtSummary).toBeNull();
  });

  it('above the threshold with no bounds reported yet, renders nothing rather than everything', () => {
    const cams = Array.from({ length: SCALE_TIERING_THRESHOLD + 1 }, (_, i) => makeCamera({ id: i }));
    const result = computeScaleTiering(cams, null, null);
    expect(result.isTiered).toBe(true);
    expect(result.renderableCameras).toEqual([]);
    expect(result.districtSummary).toBeNull();
  });

  it('above the threshold and zoomed out past CLUSTER_ONLY_MIN_ZOOM, returns a district summary instead of markers', () => {
    const cams = [
      ...Array.from({ length: 300 }, (_, i) => makeCamera({ id: i, dept: 'Ahmedabad', lat: 23.0, long: 72.5 })),
      ...Array.from({ length: 300 }, (_, i) => makeCamera({ id: 1000 + i, dept: 'Surat', lat: 21.2, long: 72.8 })),
    ];
    const result = computeScaleTiering(cams, GUJARAT_BOUNDS, CLUSTER_ONLY_MIN_ZOOM - 1);
    expect(result.isTiered).toBe(true);
    expect(result.renderableCameras).toEqual([]);
    expect(result.districtSummary).toEqual([
      { district: 'Ahmedabad', count: 300 },
      { district: 'Surat', count: 300 },
    ]);
  });

  it('above the threshold and zoomed in enough, viewport-filters and caps at MAX_VISIBLE_MARKERS', () => {
    const inView = Array.from({ length: MAX_VISIBLE_MARKERS + 50 }, (_, i) =>
      makeCamera({ id: i, lat: 23.0, long: 72.5 })
    );
    const outOfView = Array.from({ length: 50 }, (_, i) => makeCamera({ id: 9000 + i, lat: 28.6, long: 77.2 }));
    const cams = [...inView, ...outOfView];
    const result = computeScaleTiering(cams, GUJARAT_BOUNDS, CLUSTER_ONLY_MIN_ZOOM);
    expect(result.isTiered).toBe(true);
    expect(result.districtSummary).toBeNull();
    expect(result.renderableCameras.length).toBe(MAX_VISIBLE_MARKERS);
    // Every rendered camera really is one of the in-view ones, never one of
    // the out-of-view set that happened to be capped in instead.
    expect(result.renderableCameras.every((c) => c.id < 9000)).toBe(true);
  });
});
