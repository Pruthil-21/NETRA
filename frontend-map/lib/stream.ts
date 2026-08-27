const HLS_BASE_URL = (process.env.NEXT_PUBLIC_MEDIAMTX_HLS_URL || 'http://localhost:8888').replace(/\/+$/, '');

/**
 * Derives the MediaMTX HLS playback URL for a camera from its RTSP publish URL.
 * MediaMTX remuxes any published RTSP path to HLS at `${HLS_BASE_URL}/<path>/index.m3u8`
 * automatically, so the two only need to agree on the path segment.
 */
export function getHlsStreamUrl(rtspUrl: string): string | null {
  try {
    const path = new URL(rtspUrl).pathname.replace(/^\/+|\/+$/g, '');
    if (!path) return null;
    return `${HLS_BASE_URL}/${path}/index.m3u8`;
  } catch {
    return null;
  }
}
