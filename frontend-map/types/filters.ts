import { ConnectivityStatus, HealthStatus } from './camera';

/** The Map page's full-canvas overlays (MapFilterControl) -- mutually
 * exclusive with each other and with the plain per-camera pin view.
 * 'none' is the default: individual camera pins, Status filter active. */
export type MapLayer = 'none' | 'coverage' | 'density';

/** Which time window the density layer's camera counts come from -- see
 * lib/densityMath.ts and services/densityService.ts. */
export type DensityMode = 'live' | 'hour';

export interface CameraFilters {
  /** Selected city/department names -- empty means "every city". A camera
   * passes if its dept matches any of these, OR-ed together with
   * circleIds below (picking a city and a specific area in another city
   * means "either," not "both"). */
  departments: string[];
  /** Selected area/circle ids -- empty means "every area." */
  circleIds: number[];
  connectivity: ConnectivityStatus | 'all';
  health: HealthStatus | 'all';
  searchQuery: string;
  /** While not 'none', connectivity is forced back to 'all' so a canvas
   * layer sees every camera and classifies each one itself, and the map
   * hides individual pins in favor of that layer's own rendering. */
  mapLayer: MapLayer;
  /** 'live': a rolling window ending now (densityWindowMinutes wide).
   * 'hour': a single hour-of-day bucket (densityHour) for the playback
   * scrubber, always today's date. Only meaningful while mapLayer === 'density'. */
  densityMode: DensityMode;
  densityWindowMinutes: 15 | 30 | 60;
  /** 0-23, IST. Only meaningful while densityMode === 'hour'. */
  densityHour: number;
}
