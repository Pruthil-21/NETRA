import { describe, it, expect } from 'vitest';
import { getHlsStreamUrl } from '@/lib/stream';

describe('getHlsStreamUrl', () => {
  it('derives an HLS playlist URL from an RTSP publish URL', () => {
    expect(getHlsStreamUrl('rtsp://localhost:8554/cam1')).toBe('http://localhost:8888/cam1/index.m3u8');
  });

  it('strips leading/trailing slashes from the path segment', () => {
    expect(getHlsStreamUrl('rtsp://localhost:8554/sentinel_cam12/')).toBe(
      'http://localhost:8888/sentinel_cam12/index.m3u8'
    );
  });

  it('returns null for a URL with no path', () => {
    expect(getHlsStreamUrl('rtsp://localhost:8554')).toBeNull();
  });

  it('returns null for an invalid URL', () => {
    expect(getHlsStreamUrl('not-a-url')).toBeNull();
  });
});
