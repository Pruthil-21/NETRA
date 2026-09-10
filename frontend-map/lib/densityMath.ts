/** Color/geometry helpers for the Map page's density layer
 * (CoverageCanvasLayer's sibling -- see components/map/DensityCanvasLayer.tsx).
 * Unlike coverage (a fixed camera-reach radius classified into a handful of
 * known states), density is inherently relative: "busy" only means anything
 * next to whatever else is on screen right now, so every camera's count is
 * normalized against the current view's own maximum rather than compared to
 * a fixed threshold. */

// Wider than COVERAGE_RADIUS_METERS -- this paints a visible "how busy is
// this area" blob, not a literal camera-reach circle, so it's deliberately
// larger to read as a heat region rather than a coverage dot.
export const DENSITY_RADIUS_METERS = 300;

// Coverage can get away with a small meters-accurate radius because its
// state-wide red fill is what's visible at an overview zoom -- the reach
// circles only matter once zoomed in close. Density has no such backdrop:
// at a city/district overview (the zoom level a control room actually
// watches this at), a physically-accurate 300m radius is under two
// screen pixels and the whole layer reads as empty even with real data
// underneath. This is the floor DensityCanvasLayer clamps every blob to,
// so it stays visible at any zoom and only grows past this once zoomed in
// enough for the real meters-based radius to exceed it.
export const DENSITY_MIN_RADIUS_PX = 10;

// Rolling live-window choices surfaced in the filter panel.
export const DENSITY_WINDOW_OPTIONS = [15, 30, 60] as const;

const DENSITY_STOPS: Array<[number, [number, number, number]]> = [
  [0, [34, 197, 94]], // green-500: quiet
  [0.5, [245, 158, 11]], // amber-500: moderate
  [1, [239, 68, 68]], // red-500: busiest on screen right now
];

/** Interpolates the green -> amber -> red gradient at `ratio` (0-1, already
 * normalized by the caller against the current view's max count). */
export function densityColorForRatio(ratio: number): string {
  const r = Math.max(0, Math.min(1, ratio));
  for (let i = 1; i < DENSITY_STOPS.length; i++) {
    const [stopA, colorA] = DENSITY_STOPS[i - 1];
    const [stopB, colorB] = DENSITY_STOPS[i];
    if (r <= stopB) {
      const t = (r - stopA) / (stopB - stopA);
      const mixed = colorA.map((c, idx) => Math.round(c + (colorB[idx] - c) * t));
      return `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`;
    }
  }
  const last = DENSITY_STOPS[DENSITY_STOPS.length - 1][1];
  return `rgb(${last[0]}, ${last[1]}, ${last[2]})`;
}

/** IST hour-of-day label for the scrubber, e.g. 0 -> "12 AM", 13 -> "1 PM". */
export function formatDensityHour(hour: number): string {
  const period = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${period}`;
}
