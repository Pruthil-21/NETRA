import { describe, it, expect } from 'vitest';
import { computeBestFitGrid, GAP_PX } from '@/hooks/useBestFitTileSize';

describe('computeBestFitGrid', () => {
  it('keeps tiles close to 16:9, never stretched into a wide-and-short shape', () => {
    // The exact bug reported: 5 tiles in a wide, short container (a typical
    // dashboard content area) previously forced into a naive ceil(sqrt(5))=3
    // column grid, producing very wide, very short cells.
    const size = computeBestFitGrid(5, 1600, 500);
    const ratio = size.tileWidth / size.tileHeight;
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(1.9); // close to 16:9 (~1.78), not badly stretched
  });

  it('a single tile fills the container up to its own aspect ratio, not the whole box', () => {
    const size = computeBestFitGrid(1, 1600, 900);
    expect(size.cols).toBe(1);
    expect(size.rows).toBe(1);
    expect(size.tileWidth / size.tileHeight).toBeCloseTo(16 / 9, 1);
  });

  it('returns a zero size for an empty or unmeasured container without throwing', () => {
    expect(computeBestFitGrid(0, 1000, 1000)).toEqual({ cols: 1, rows: 1, tileWidth: 0, tileHeight: 0 });
    expect(computeBestFitGrid(4, 0, 0)).toEqual({ cols: 1, rows: 1, tileWidth: 0, tileHeight: 0 });
  });

  it('balances rows instead of greedily maxing out one row and dumping the rest on their own line', () => {
    // The exact reported bug: a wide container made 5 tiles line up in one
    // row of 5 (or a lopsided 4+1) because that scored higher on raw area
    // alone. Fill-ratio-weighted scoring should prefer the balanced 3+2.
    const five = computeBestFitGrid(5, 1600, 500);
    expect(five.cols).toBe(3);
    expect(five.rows).toBe(2);

    // 9 tiles have an exact 3x3 fit available -- a "lines up 4, wraps"
    // result (cols=4, leaving a near-empty last row) must lose to it.
    const nine = computeBestFitGrid(9, 1600, 700);
    expect(nine.cols).toBe(3);
    expect(nine.rows).toBe(3);
  });

  it('picks a layout that fits every tile within the container bounds', () => {
    for (const count of [2, 3, 4, 5, 6, 7, 9]) {
      const size = computeBestFitGrid(count, 1400, 700);
      expect(size.cols * size.rows).toBeGreaterThanOrEqual(count);
      const totalWidth = size.cols * size.tileWidth + (size.cols - 1) * GAP_PX;
      const totalHeight = size.rows * size.tileHeight + (size.rows - 1) * GAP_PX;
      expect(totalWidth).toBeLessThanOrEqual(1400 + 1); // +1 for float rounding
      expect(totalHeight).toBeLessThanOrEqual(700 + 1);
    }
  });
});
