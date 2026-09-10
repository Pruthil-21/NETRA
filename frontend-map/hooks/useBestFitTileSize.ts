'use client';

import { useEffect, useRef, useState } from 'react';

export interface TileSize {
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
}

// A hairline divider, not a real gutter -- matches how actual VMS video
// walls (Milestone XProtect, Genetec Security Center, Hikvision iVMS,
// Videonetics) tile cameras: edge-to-edge, separated by a 1-2px border, not
// whitespace.
export const GAP_PX = 2;
// Real camera feeds are ~16:9 -- tiles are sized to stay close to that shape
// (stretching cells to fill 100% of the container regardless of aspect was
// tried and reverted: it read as feeds squished toward square, worse than
// the empty margin it was meant to fix).
const ASPECT_RATIO = 16 / 9;

/** Video-wall best-fit: try every plausible column count and score each by
 * how much of the container it would use *and* how close to a real
 * camera's 16:9 shape the resulting cell would be (fillRatio * area) --
 * this is what picks a balanced 3+2 over a lopsided 4+1, or a perfect 3x3
 * over a wasteful 4-column split (see the reported "lines up 4, wraps" bug
 * this fixes), while keeping every tile close to how a camera actually
 * looks rather than stretched into whatever shape a raw N-rows-x-M-cols
 * split happens to leave. */
export function computeBestFitGrid(count: number, containerWidth: number, containerHeight: number): TileSize {
  if (count <= 0 || containerWidth <= 0 || containerHeight <= 0) {
    return { cols: 1, rows: 1, tileWidth: 0, tileHeight: 0 };
  }
  let best: TileSize & { score: number } = { score: 0, cols: 1, rows: count, tileWidth: 0, tileHeight: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const cellWidth = (containerWidth - GAP_PX * (cols - 1)) / cols;
    const cellHeight = (containerHeight - GAP_PX * (rows - 1)) / rows;
    if (cellWidth <= 0 || cellHeight <= 0) continue;

    let tileWidth = cellWidth;
    let tileHeight = tileWidth / ASPECT_RATIO;
    if (tileHeight > cellHeight) {
      tileHeight = cellHeight;
      tileWidth = tileHeight * ASPECT_RATIO;
    }

    const area = tileWidth * tileHeight;
    const fillRatio = count / (rows * cols);
    const score = area * fillRatio;
    if (score > best.score) best = { score, cols, rows, tileWidth, tileHeight };
  }
  const { score: _score, ...size } = best;
  return size;
}

/** Measures its returned ref's actual rendered size (via ResizeObserver, so
 * it stays correct across window resizes and sidebar toggles) and derives
 * the best-fit tile size for `count` tiles inside it. */
export function useBestFitTileSize(count: number): [React.RefObject<HTMLDivElement | null>, TileSize] {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<TileSize>({ cols: 1, rows: 1, tileWidth: 0, tileHeight: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const recompute = () => {
      const { width, height } = el.getBoundingClientRect();
      setSize(computeBestFitGrid(count, width, height));
    };

    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [count]);

  return [containerRef, size];
}
