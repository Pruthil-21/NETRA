/**
 * Raw camera shape returned by the organizer's live CCTV metadata API
 * (https://live.corp8.cloud/api/cameras, proxied via /api/organizer-cameras).
 * Only the fields this app actually uses are declared.
 */
export interface OrganizerCamera {
  id: string;
  name?: string;
  location?: string;
  status?: string;
  width?: number;
  height?: number;
  rtsp_url?: string;
  // Not part of the organizer API's real response — optional so a manually
  // added or bulk-imported camera (see lib/manualCameras.ts) can carry a real
  // surveyed position instead of falling back to a curated/guessed one.
  lat?: number;
  long?: number;
  // Also not part of the organizer API. A manually added camera has no
  // MediaMTX path unless the streaming engineer already set one up for it —
  // rtsp_url alone can't be played in a browser, so without one of these the
  // camera is registry-only (no live feed) until it's supplied.
  stream_path?: string;
  hls_url?: string;
}
