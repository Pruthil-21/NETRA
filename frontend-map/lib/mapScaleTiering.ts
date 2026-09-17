import { Camera } from '@/types/camera';

/** Same viewport-bounded + zoom-tiered rendering strategy already proven on
 * the /scale demo page (components/scale/ScaleMap.tsx, real backend bbox
 * queries + a district-count fallback when zoomed out too far) — applied
 * here to the real, live camera registry's own map instead of synthetic
 * load-test data.
 *
 * The key difference from ScaleMap: CameraRegistryContext already holds the
 * FULL real registry in memory (that's its own separate, existing, and
 * unchanged behavior — Dashboard/Search/Alerts/Admin all depend on it), so
 * this doesn't need to re-fetch per viewport change the way ScaleMap does
 * against a genuinely server-side-paginated synthetic dataset. It only
 * needs to cull what's already in memory down to "what's actually worth
 * turning into a DOM marker right now" — a client-side filter, not a
 * network round trip. Below SCALE_TIERING_THRESHOLD total registered
 * cameras (today's real count, ~30-100), none of this runs at all: every
 * camera in `cameras` renders exactly as it always has. */

export interface ViewportBounds {
  minLat: number;
  maxLat: number;
  minLong: number;
  maxLong: number;
}

export interface DistrictCount {
  district: string;
  count: number;
}

// Same numbers ScaleMap.tsx already validated: past this many total
// registered cameras, per-camera markers start costing real render time;
// past this many *visible* markers in one viewport, the browser is doing
// pointless work drawing pins nobody can visually distinguish anyway.
export const SCALE_TIERING_THRESHOLD = 500;
export const MAX_VISIBLE_MARKERS = 500;
// Zoomed out past this, a real statewide viewport contains far more
// markers than are useful to show individually — a district-level count
// answers "where are my cameras" better than a screen of overlapping pins.
export const CLUSTER_ONLY_MIN_ZOOM = 9;

export function isCameraInBounds(cam: Camera, bounds: ViewportBounds): boolean {
  const long = cam.long ?? 0;
  return (
    cam.lat >= bounds.minLat &&
    cam.lat <= bounds.maxLat &&
    long >= bounds.minLong &&
    long <= bounds.maxLong
  );
}

export function filterCamerasToViewport(cameras: Camera[], bounds: ViewportBounds): Camera[] {
  return cameras.filter((cam) => isCameraInBounds(cam, bounds));
}

/** Real per-district counts over whatever camera set is passed in (already
 * viewport-filtered by the caller) — client-side GROUP BY, safe here
 * specifically because the input is the full in-memory registry, not one
 * possibly-truncated server page (see ScaleMap's own get_district_summary
 * docstring for why a truncated page would under-report a large district;
 * that risk doesn't exist when nothing was ever truncated to begin with). */
export function districtSummaryFor(cameras: Camera[]): DistrictCount[] {
  const counts = new Map<string, number>();
  for (const cam of cameras) {
    counts.set(cam.dept, (counts.get(cam.dept) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([district, count]) => ({ district, count }))
    .sort((a, b) => b.count - a.count);
}

export interface ScaleTieringResult {
  /** Cameras that should actually become <Marker> elements this render —
   * either every camera (registry small enough that tiering never kicks
   * in), or the viewport-filtered, marker-count-capped subset. */
  renderableCameras: Camera[];
  /** Non-null exactly when zoomed out too far over a large registry —
   * render this instead of individual markers. */
  districtSummary: DistrictCount[] | null;
  /** True whenever tiering logic is active at all (large registry) — lets
   * the caller show a "N of M cameras shown, zoom in for more" hint only
   * when it's actually true, not on every render. */
  isTiered: boolean;
}

export function computeScaleTiering(
  cameras: Camera[],
  bounds: ViewportBounds | null,
  zoom: number | null
): ScaleTieringResult {
  if (cameras.length <= SCALE_TIERING_THRESHOLD) {
    return { renderableCameras: cameras, districtSummary: null, isTiered: false };
  }
  // Bounds not reported yet (first paint, before the tracker's mount
  // effect fires) — render nothing rather than the whole large registry
  // for one frame; the tracker reports real bounds immediately on mount,
  // same as ScaleMap.tsx's BoundsWatcher does, so this window is brief.
  if (bounds === null || zoom === null) {
    return { renderableCameras: [], districtSummary: null, isTiered: true };
  }
  if (zoom < CLUSTER_ONLY_MIN_ZOOM) {
    return {
      renderableCameras: [],
      districtSummary: districtSummaryFor(filterCamerasToViewport(cameras, bounds)),
      isTiered: true,
    };
  }
  const inView = filterCamerasToViewport(cameras, bounds);
  return {
    renderableCameras: inView.slice(0, MAX_VISIBLE_MARKERS),
    districtSummary: null,
    isTiered: true,
  };
}
