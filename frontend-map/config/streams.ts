// Service base URLs — see contract/API_CONTRACT.md and each service's own README.
export const REGISTRY_API_URL = process.env.NEXT_PUBLIC_REGISTRY_API_URL || "http://localhost:8000";
export const WATCHLIST_API_URL = process.env.NEXT_PUBLIC_WATCHLIST_API_URL || "http://localhost:8001";
export const MEDIAMTX_HLS_URL = process.env.NEXT_PUBLIC_MEDIAMTX_HLS_URL || "http://localhost:8888";

// Used when a camera has no resolvable live path (e.g. local dev with no MediaMTX running).
export const FALLBACK_STREAM = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

/**
 * Builds the HLS manifest URL for a registry camera.
 *
 * backend-registry's /cameras now returns `stream_id` and `hls_url` per camera (added
 * for the corp8.cloud-sourced live relays — see streaming/README.md's "Stream paths":
 * `{cloudflareBaseUrl}/stream/{cameraId}/index.m3u8`). Preference order:
 *   1. `hls_url` if the registry already gives a full URL — use it as-is.
 *   2. `stream_id` if set — the provider's own camera id.
 *   3. Otherwise fall back to the registry's own `id` under the same `/stream/{id}/`
 *      convention. The older `/camera{id}/index.m3u8` path from Phase 0 is no longer
 *      served by the current streaming setup (confirmed against streaming/README.md,
 *      which only documents `/stream/{cameraId}/` now) — using it would silently
 *      404 for every camera that predates the corp8 relay.
 */
export function buildHlsUrl(
  cameraId: string | number,
  streamId?: string | number | null,
  hlsUrl?: string | null
): string {
  if (hlsUrl) return hlsUrl;
  const pathId = streamId || cameraId;
  return `${MEDIAMTX_HLS_URL}/stream/${pathId}/index.m3u8`;
}
