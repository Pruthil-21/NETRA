import { ConnectivityStatus, HealthStatus } from './camera';

/** The Map page's full-canvas overlays (MapFilterControl) -- mutually
 * exclusive with each other and with the plain per-camera pin view.
 * 'none' is the default: individual camera pins, Status filter active. */
export type MapLayer = 'none' | 'coverage' | 'density' | 'flow';

/** Which time window a layer's data comes from -- 'live': a rolling
 * window ending now. 'hour': a single hour-of-day bucket for the playback
 * scrubber. Shared shape for both Density and Flow, which each keep their
 * own independent window state (see CameraFilters below) since an officer
 * may want a different window per layer. */
export type LayerWindowMode = 'live' | 'hour';

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
  /** Only meaningful while mapLayer === 'density'. */
  densityMode: LayerWindowMode;
  densityWindowMinutes: 15 | 30 | 60;
  /** 0-23, IST. Only meaningful while densityMode === 'hour'. */
  densityHour: number;
  /** Flow's own window state, independent of density's -- see
   * densityMode/densityWindowMinutes/densityHour above. Only meaningful
   * while mapLayer === 'flow'. */
  flowMode: LayerWindowMode;
  flowWindowMinutes: 15 | 30 | 60;
  /** 0-23, IST. Only meaningful while flowMode === 'hour'. */
  flowHour: number;
}
