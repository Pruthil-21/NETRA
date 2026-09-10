import { describe, it, expect } from 'vitest';
import {
  coverageStatusForCamera,
  isWithinGujarat,
  metersToPixelRadius,
  GUJARAT_BOUNDS,
} from '@/lib/coverageMath';
import { Camera } from '@/types/camera';

function makeCamera(overrides: Partial<Camera> = {}): Camera {
  return {
    id: 1,
    name: 'Test Camera',
    dept: 'Anand',
    lat: 22.5645,
    long: 72.9289,
    camera_type: 'ANPR',
    ownership: 'Anand Police',
    connectivity_status: 'online',
    storage_type: 'Cloud',
    retention_days: 30,
    health_status: 'operational',
    rtsp_url: '',
    ...overrides,
  };
}

describe('coverageStatusForCamera', () => {
  it('is "operational" only when online and healthy', () => {
    expect(coverageStatusForCamera(makeCamera({ connectivity_status: 'online', health_status: 'operational' }))).toBe(
      'operational'
    );
  });

  it('is "degraded" when online but not healthy', () => {
    expect(coverageStatusForCamera(makeCamera({ connectivity_status: 'online', health_status: 'fault' }))).toBe(
      'degraded'
    );
    expect(coverageStatusForCamera(makeCamera({ connectivity_status: 'online', health_status: 'degraded' }))).toBe(
      'degraded'
    );
  });

  it('is "degraded" (not skipped) when fully offline -- a dead camera still marks a watched-but-unreliable spot', () => {
    expect(coverageStatusForCamera(makeCamera({ connectivity_status: 'offline', health_status: 'operational' }))).toBe(
      'degraded'
    );
    expect(coverageStatusForCamera(makeCamera({ connectivity_status: 'offline', health_status: 'fault' }))).toBe(
      'degraded'
    );
  });
});

describe('isWithinGujarat', () => {
  it('accepts real Gujarat coordinates', () => {
    expect(isWithinGujarat(22.5645, 72.9289)).toBe(true); // Anand
    expect(isWithinGujarat(23.0225, 72.5714)).toBe(true); // Ahmedabad
  });

  it('rejects a coordinate well outside Gujarat', () => {
    expect(isWithinGujarat(28.6139, 77.209)).toBe(false); // Delhi
    expect(isWithinGujarat(0, 0)).toBe(false); // null island
  });

  it('rejects a point inside the old bounding-box approximation but outside the real coastline', () => {
    // Open Arabian Sea south of Veraval -- within GUJARAT_BOUNDS' rectangle,
    // but not actually Gujarat. This is exactly the bug a plain bbox check
    // used to get wrong (a rectangle painted the whole sea red too).
    expect(isWithinGujarat(20.5, 70.0)).toBe(false);
  });

  it('stays within the bbox pre-filter\'s own extent (a sanity bound, not a claim of accuracy)', () => {
    expect(isWithinGujarat(GUJARAT_BOUNDS.south - 1, 71)).toBe(false);
    expect(isWithinGujarat(GUJARAT_BOUNDS.north + 1, 71)).toBe(false);
  });
});

describe('metersToPixelRadius', () => {
  it('grows as zoom increases, for a fixed radius and latitude', () => {
    const atZoom10 = metersToPixelRadius(22.5, 10, 80);
    const atZoom15 = metersToPixelRadius(22.5, 15, 80);
    expect(atZoom15).toBeGreaterThan(atZoom10);
    // Doubling zoom levels doubles pixel density each step -- 5 levels up
    // should be a 32x radius, within floating-point tolerance.
    expect(atZoom15 / atZoom10).toBeCloseTo(32, 0);
  });

  it('returns a positive, finite value for a realistic Gujarat latitude/zoom', () => {
    const px = metersToPixelRadius(22.5645, 13, 80);
    expect(px).toBeGreaterThan(0);
    expect(Number.isFinite(px)).toBe(true);
  });
});
