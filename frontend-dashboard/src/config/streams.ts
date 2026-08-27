// Service base URLs — see contract/API_CONTRACT.md and each service's own README.
export const REGISTRY_API_URL = process.env.NEXT_PUBLIC_REGISTRY_API_URL || "http://localhost:8000";
export const WATCHLIST_API_URL = process.env.NEXT_PUBLIC_WATCHLIST_API_URL || "http://localhost:8001";
export const MEDIAMTX_HLS_URL = process.env.NEXT_PUBLIC_MEDIAMTX_HLS_URL || "http://localhost:8888";

// Used when a camera has no resolvable live path (e.g. local dev with no MediaMTX running).
export const FALLBACK_STREAM = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

/**
 * Builds the HLS manifest URL for a registry camera id.
 *
 * Path convention per streaming/README.md's "Endpoint Contract" (confirmed with the
 * streaming teammate): `<mediamtx-host>:8888/camera<id>/index.m3u8`. Only `camera1`
 * (and `livecam`) are actually published as of Phase 0 — other ids will 404/black-screen
 * until the streaming teammate wires up the rest, which FeedCard's OFFLINE state covers.
 */
export function buildHlsUrl(cameraId: string | number): string {
  return `${MEDIAMTX_HLS_URL}/camera${cameraId}/index.m3u8`;
}
