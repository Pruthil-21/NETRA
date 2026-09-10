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
   * MediaMTX stream id (`${NEXT_PUBLIC_MEDIAMTX_HLS_URL}/stream/{stream_id}/index.m3u8`) —
   * numeric for organizer cameras (e.g. `8`), a string path for others (e.g. `pruthil-phone`).
   * Registry camera ids (e.g. `CAM-GJ-001`) are not guaranteed to match a stream id, so this is
   * a separate, explicit field. `null`/absent means no live feed is provisioned for this camera.
   */
  stream_id?: number | string | null;
  /**
   * Fully-qualified LL-HLS playlist URL for cameras publishing to a different
   * MediaMTX instance/tunnel than the shared organizer base (e.g. a standalone
   * test rig). Takes priority over `stream_id` when both are set.
   * See `lib/testCameras.ts`.
   */
  hls_url?: string | null;
  /**
   * The District→Circle tree grouping this camera belongs to (see
   * services/circlesService.ts). `null`/absent means the camera is
   * unassigned — it still appears in its district's combined grid, just
   * not under any Circle node.
   */
  circle_id?: number | null;
}