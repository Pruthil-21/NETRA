import { Camera } from '@/types/camera';

/**
 * Standalone CCTV/phone test cameras — separate from the registry (backend-registry)
 * and organizer (lib/organizerCameras.ts) feeds. Each publishes to its own MediaMTX
 * instance/tunnel (not the shared organizer base), so the stream URL is a full,
 * directly-configured `hls_url` rather than a `stream_id` resolved against
 * `NEXT_PUBLIC_MEDIAMTX_HLS_URL`.
 *
 * To add another test camera, add another entry here — nothing else needs to change,
 * it flows through the existing registry, map, and marker rendering automatically.
 */
export const TEST_CCTV_CAMERAS: Camera[] = [
  {
    // Reserved id range (9000+) so this can never collide with a registry or
    // organizer camera id.
    id: 9001,
    name: "Pruthil's Phone",
    dept: 'Petlad, Gujarat',
    lat: 22.4768,
    long: 72.7999,
    camera_type: 'Bullet',
    ownership: 'NETRA Test Rig',
    connectivity_status: 'offline',
    storage_type: 'Cloud',
    retention_days: 0,
    health_status: 'degraded',
    rtsp_url: '',
    stream_id: null,
    hls_url: process.env.NEXT_PUBLIC_PHONE_CAM_HLS_URL || null,
  },
];
