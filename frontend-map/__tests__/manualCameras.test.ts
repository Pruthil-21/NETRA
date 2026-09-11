import { describe, it, expect } from 'vitest';
import { buildSampleCsv, buildSampleJson, parseCameraCsv, parseCameraJson } from '@/lib/manualCameras';

describe('sample import templates', () => {
  it('the sample CSV round-trips cleanly through the real CSV parser', () => {
    const result = parseCameraCsv(buildSampleCsv());
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].id).toBe('101');
    expect(result.rows[0].stream_path).toBe('12');
    // The second sample row demonstrates "add now, connect later" -- no
    // stream_path/hls_url is a valid row, not a parse error.
    expect(result.rows[1].stream_path).toBeUndefined();
    expect(result.rows[1].hls_url).toBeUndefined();
  });

  it('the sample JSON round-trips cleanly through the real JSON parser', () => {
    const result = parseCameraJson(buildSampleJson());
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].id).toBe('101');
    expect(result.rows[0].lat).toBeCloseTo(23.0733);
  });
});
