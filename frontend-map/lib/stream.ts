export type StreamUnavailableReason = 'not-configured' | 'no-stream';
export type StreamUrlResult = { url: string; reason?: undefined } | { url: null; reason: StreamUnavailableReason };

/**
 * Builds the MediaMTX HLS playlist URL for a camera's `stream_id` — numeric for
 * organizer cameras (e.g. `8`), or a string path for others (e.g. `pruthil-phone`).
 * Never falls back to a hardcoded host: a missing `NEXT_PUBLIC_MEDIAMTX_HLS_URL`
 * is a configuration error the UI should surface, not silently mask.
 */
export function getHlsStreamUrl(streamId: number | string | null | undefined): StreamUrlResult {
  const base = process.env.NEXT_PUBLIC_MEDIAMTX_HLS_URL;
  if (!base) return { url: null, reason: 'not-configured' };
  if (streamId === null || streamId === undefined || streamId === '') return { url: null, reason: 'no-stream' };

  const trimmedBase = base.replace(/\/+$/, '');
  return { url: `${trimmedBase}/stream/${streamId}/index.m3u8?cookieCheck=1` };
}

/**
 * Resolves a camera's already-fully-qualified `hls_url` (see `types/camera.ts`),
 * for cameras publishing to a different MediaMTX instance/tunnel than the shared
 * `NEXT_PUBLIC_MEDIAMTX_HLS_URL` base used by `getHlsStreamUrl` above.
 */
export function getDirectStreamUrl(hlsUrl: string | null | undefined): StreamUrlResult {
  if (!hlsUrl) return { url: null, reason: 'not-configured' };
  return { url: hlsUrl };
}

/**
 * One place that decides which of the two URL builders above applies to a
 * given camera — hls_url (standalone cameras on their own MediaMTX instance)
 * takes priority over stream_id (organizer/registry cameras on the shared
 * relay). Used by both the detail drawer and the background health check so
 * they always agree on what "this camera's stream" means.
 */
export function getCameraStreamUrl(camera: {
  hls_url?: string | null;
  stream_id?: number | string | null;
}): StreamUrlResult {
  return camera.hls_url ? getDirectStreamUrl(camera.hls_url) : getHlsStreamUrl(camera.stream_id);
}
