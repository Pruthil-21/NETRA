export type ConnectivityStatus = 'online' | 'offline';
export type HealthStatus = 'operational' | 'degraded' | 'fault';
export type CameraType = 'PTZ' | 'Dome' | 'Bullet' | 'ANPR';
export type StorageType = 'Local' | 'Cloud' | 'Hybrid';

export interface Camera {
  id: number;
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
  /**
   * Numeric MediaMTX stream id (`${NEXT_PUBLIC_MEDIAMTX_HLS_URL}/stream/{stream_id}/index.m3u8`).
   * Registry camera ids (e.g. `CAM-GJ-001`) are not guaranteed to match a stream id, so this is
   * a separate, explicit field. `null`/absent means no live feed is provisioned for this camera.
   */
  stream_id?: number | null;
}