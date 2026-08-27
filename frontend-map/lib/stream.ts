export type StreamUnavailableReason = 'not-configured' | 'no-stream';
export type StreamUrlResult = { url: string; reason?: undefined } | { url: null; reason: StreamUnavailableReason };

/**
 * Builds the MediaMTX HLS playlist URL for a camera's numeric `stream_id`.
 * Never falls back to a hardcoded host: a missing `NEXT_PUBLIC_MEDIAMTX_HLS_URL`
 * is a configuration error the UI should surface, not silently mask.
 */
export function getHlsStreamUrl(streamId: number | null | undefined): StreamUrlResult {
  const base = process.env.NEXT_PUBLIC_MEDIAMTX_HLS_URL;
  if (!base) return { url: null, reason: 'not-configured' };
  if (streamId === null || streamId === undefined) return { url: null, reason: 'no-stream' };

  const trimmedBase = base.replace(/\/+$/, '');
  return { url: `${trimmedBase}/stream/${streamId}/index.m3u8` };
}
