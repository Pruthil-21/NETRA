export type ConnectivityStatus = 'online' | 'offline';
export type HealthStatus = 'operational' | 'degraded' | 'fault';
export type CameraType = 'PTZ' | 'Dome' | 'Bullet' | 'ANPR';
export type StorageType = 'Local' | 'Cloud' | 'Hybrid';

export interface Camera {
  id: string;
  name: string;
  dept: string;
  lat: number;
  long: number;
  camera_type: CameraType;
  ownership: string;
  connectivity_status: ConnectivityStatus;
  storage_type: StorageType;
  retention_days: number;
  health_status: HealthStatus;
  rtsp_url: string;
}