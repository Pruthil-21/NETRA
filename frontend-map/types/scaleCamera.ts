export interface ScaleCamera {
  id: number;
  name: string;
  dept: string;
  lat: number;
  long: number;
  camera_type: string;
  ownership: string;
  connectivity_status: 'online' | 'degraded' | 'offline';
  storage_type: string;
  retention_days: number;
  health_status: 'operational' | 'degraded' | 'fault';
  rtsp_url: string | null;
  stream_id?: number | string | null;
  hls_url?: string | null;
  is_synthetic: boolean;
  edge_node_id: number | null;
}

export interface ScaleCameraPage {
  cameras: ScaleCamera[];
  next_cursor: number | null;
}

export interface ScaleSummary {
  total: number;
  online: number;
  degraded: number;
  offline: number;
  real_stream_count: number;
  synthetic_count: number;
  edge_node_count: number;
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLong: number;
  maxLong: number;
}

export interface DistrictCount {
  district: string;
  count: number;
}
