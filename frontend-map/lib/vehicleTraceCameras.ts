import { Camera } from '@/types/camera';

/**
 * Petlad checkpoint cameras for the vehicle-trace demo (plate GX15OGJ,
 * 101 -> 102 -> 103). Coordinates are temporary per Anushka's handoff --
 * replace with her confirmed values once the real trace/detection contract
 * lands (currently backend-watchlist's GET /detections, unchanged).
 *
 * stream_id matches the MediaMTX path segment (`/stream/101/whep` etc.) --
 * resolved against NEXT_PUBLIC_MEDIAMTX_WEBRTC_URL (Tailscale-only), same
 * as every other camera. No URL is hardcoded here.
 */
export const VEHICLE_TRACE_DEMO_CAMERAS: Camera[] = [
  {
    id: 101,
    name: 'Petlad Entry Checkpoint',
    dept: 'Petlad, Gujarat',
    lat: 22.4729,
    long: 72.7938,
    camera_type: 'ANPR',
    ownership: 'NETRA Vehicle-Trace Demo',
    connectivity_status: 'offline',
    storage_type: 'Cloud',
    retention_days: 0,
    health_status: 'operational',
    rtsp_url: '',
    stream_id: '101',
    hls_url: null,
  },
  {
    id: 102,
    name: 'Petlad Town Centre',
    dept: 'Petlad, Gujarat',
    lat: 22.4766,
    long: 72.7994,
    camera_type: 'ANPR',
    ownership: 'NETRA Vehicle-Trace Demo',
    connectivity_status: 'offline',
    storage_type: 'Cloud',
    retention_days: 0,
    health_status: 'operational',
    rtsp_url: '',
    stream_id: '102',
    hls_url: null,
  },
  {
    id: 103,
    name: 'Petlad Exit Checkpoint',
    dept: 'Petlad, Gujarat',
    lat: 22.4804,
    long: 72.8051,
    camera_type: 'ANPR',
    ownership: 'NETRA Vehicle-Trace Demo',
    connectivity_status: 'offline',
    storage_type: 'Cloud',
    retention_days: 0,
    health_status: 'operational',
    rtsp_url: '',
    stream_id: '103',
    hls_url: null,
  },
];
