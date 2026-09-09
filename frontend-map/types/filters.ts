import { ConnectivityStatus, HealthStatus } from './camera';

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
  /** Coverage-map view (MapFilterControl) -- while true, connectivity is
   * forced back to 'all' so the coverage layer sees every camera and
   * classifies each one itself (see lib/coverageMath.ts), and the map
   * hides individual pins in favor of the canvas coverage layer. */
  coverageEnabled: boolean;
}
