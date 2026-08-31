import { ConnectivityStatus, HealthStatus } from './camera';

export interface CameraFilters {
  department: string;
  connectivity: ConnectivityStatus | 'all';
  health: HealthStatus | 'all';
  searchQuery: string;
}