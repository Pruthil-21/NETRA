import { describe, it, expect } from 'vitest';
import { densityColorForRatio, formatDensityHour } from '@/lib/densityMath';

describe('densityColorForRatio', () => {
  it('is green at ratio 0 (quiet)', () => {
    expect(densityColorForRatio(0)).toBe('rgb(34, 197, 94)');
  });

  it('is amber at ratio 0.5 (moderate)', () => {
    expect(densityColorForRatio(0.5)).toBe('rgb(245, 158, 11)');
  });

  it('is red at ratio 1 (busiest on screen)', () => {
    expect(densityColorForRatio(1)).toBe('rgb(239, 68, 68)');
  });

  it('clamps values outside [0, 1]', () => {
    expect(densityColorForRatio(-0.5)).toBe(densityColorForRatio(0));
    expect(densityColorForRatio(1.5)).toBe(densityColorForRatio(1));
  });

  it('interpolates smoothly between stops rather than snapping', () => {
    const quarter = densityColorForRatio(0.25);
    // Halfway between green (34,197,94) and amber (245,158,11) at t=0.5 of that leg.
    expect(quarter).toBe('rgb(140, 178, 53)');
  });
});

describe('formatDensityHour', () => {
  it('formats midnight and noon correctly', () => {
    expect(formatDensityHour(0)).toBe('12 AM');
    expect(formatDensityHour(12)).toBe('12 PM');
  });

  it('formats a morning and an afternoon hour', () => {
    expect(formatDensityHour(8)).toBe('8 AM');
    expect(formatDensityHour(20)).toBe('8 PM');
  });
});
