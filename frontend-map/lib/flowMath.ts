/** Geometry helpers for the Map page's Flow layer
 * (see components/map/FlowCanvasLayer.tsx). A corridor's color reuses
 * densityColorForRatio from lib/densityMath.ts -- same green-amber-red
 * gradient, just fed a "how congested" ratio (1 - normalized speed)
 * instead of a "how busy" one, so slow corridors read red and
 * free-flowing ones read green without a second color scale to maintain. */

// Line width floor/ceiling in screen pixels, regardless of zoom -- a
// corridor's importance (transition volume) is a relative visual signal,
// not a physical measurement, so it doesn't need meters-to-pixel scaling
// the way a coverage/density radius does. Floor raised from 2 to 4 (a
// hairline reads as noise, not a corridor) and ceiling from 8 to 12 (the
// busiest corridor on screen should look unmistakably bold).
export const FLOW_MIN_WIDTH_PX = 4;
export const FLOW_MAX_WIDTH_PX = 12;

/** Line width for a corridor whose transition count is `ratio` (0-1) of
 * the busiest corridor currently on screen. */
export function flowWidthForRatio(ratio: number): number {
  const r = Math.max(0, Math.min(1, ratio));
  return FLOW_MIN_WIDTH_PX + (FLOW_MAX_WIDTH_PX - FLOW_MIN_WIDTH_PX) * r;
}
