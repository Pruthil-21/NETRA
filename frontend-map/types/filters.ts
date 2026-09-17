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
   * areaIds below (picking a city and a specific area in another city
   * means "either," not "both"). */
  departments: string[];
  /** Selected owning GOVERNMENT DEPARTMENTS (Police/GSRTC/Panchayat/
   * Municipal Corporation/Health/...) -- see Camera.owning_department.
   * Empty means "every department, including untagged cameras." Distinct
   * from `departments` above (which is really city/district) on purpose --
   * same reasoning as the backend's separate owning_department column. */
  owningDepartments: string[];
  /** Selected area/area ids -- empty means "every area." */
  areaIds: number[];
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
  /** Independent of mapLayer -- a police station pin isn't a per-camera
   * marker, so it isn't affected by the coverage/density/flow overlays
   * that hide camera pins. Defaults to true. */
  showPoliceStations: boolean;
  /** Model 1's spec asks for a GIS map layer per "department, camera type,
   * status, and coverage" -- department/status/coverage already existed as
   * filters/layers, camera type didn't. Independent of mapLayer on purpose
   * (real GIS layer panels like ArcGIS/QGIS stack symbology layers rather
   * than making them mutually exclusive): toggling this recolors/reshapes
   * marker icons by camera_type without hiding whatever coverage/density/
   * flow layer is also active. Defaults to false -- off means every marker
   * looks exactly as it always has, zero visual change for anyone who
   * never opens this toggle. */
  showCameraType: boolean;
}
