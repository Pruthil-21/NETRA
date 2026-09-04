import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getHlsStreamUrl, getDirectStreamUrl } from '@/lib/stream';

describe('getHlsStreamUrl', () => {
  const ORIGINAL_ENV = process.env.NEXT_PUBLIC_MEDIAMTX_HLS_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_MEDIAMTX_HLS_URL = 'http://localhost:8888';
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_MEDIAMTX_HLS_URL = ORIGINAL_ENV;
  });

  it('builds the MediaMTX HLS playlist URL from a numeric stream id', () => {
    expect(getHlsStreamUrl(6)).toEqual({ url: 'http://localhost:8888/stream/6/index.m3u8?cookieCheck=1' });
  });

  it('builds the MediaMTX HLS playlist URL from a string stream id', () => {
    expect(getHlsStreamUrl('pruthil-phone')).toEqual({
      url: 'http://localhost:8888/stream/pruthil-phone/index.m3u8?cookieCheck=1',
    });
  });

  it('strips a trailing slash from the base URL', () => {
    process.env.NEXT_PUBLIC_MEDIAMTX_HLS_URL = 'http://localhost:8888/';
    expect(getHlsStreamUrl(16)).toEqual({ url: 'http://localhost:8888/stream/16/index.m3u8?cookieCheck=1' });
  });

  it('returns a no-stream reason when the camera has no stream_id', () => {
    expect(getHlsStreamUrl(null)).toEqual({ url: null, reason: 'no-stream' });
    expect(getHlsStreamUrl(undefined)).toEqual({ url: null, reason: 'no-stream' });
    expect(getHlsStreamUrl('')).toEqual({ url: null, reason: 'no-stream' });
  });

  it('returns a not-configured reason when the env var is missing', () => {
    delete process.env.NEXT_PUBLIC_MEDIAMTX_HLS_URL;
    expect(getHlsStreamUrl(6)).toEqual({ url: null, reason: 'not-configured' });
  });
});

describe('getDirectStreamUrl', () => {
  it('passes through an already-qualified hls_url', () => {
    expect(getDirectStreamUrl('https://phone-cam.example.com/stream/index.m3u8')).toEqual({
      url: 'https://phone-cam.example.com/stream/index.m3u8',
    });
  });

  it('returns a not-configured reason when hls_url is missing', () => {
    expect(getDirectStreamUrl(null)).toEqual({ url: null, reason: 'not-configured' });
    expect(getDirectStreamUrl(undefined)).toEqual({ url: null, reason: 'not-configured' });
    expect(getDirectStreamUrl('')).toEqual({ url: null, reason: 'not-configured' });
  });
});
