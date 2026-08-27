export type ConnectivityStatus = 'online' | 'offline';
export type HealthStatus = 'operational' | 'degraded' | 'fault';
export type CameraType = 'PTZ' | 'Dome' | 'Bullet' | 'ANPR';
export type StorageType = 'Local' | 'Cloud' | 'Hybrid';

export interface Camera {
  id: string | number;
  name: string;
  dept: string;
  lat: number;
  long: number;
  lng?: number;
  status?: 'online' | 'offline' | string;
  connectivity?: 'online' | 'offline' | string;
  health?: 'operational' | 'degraded' | 'fault' | string;
  location?: string;
  rtspUrl?: string;
  storagePolicy?: string;
}