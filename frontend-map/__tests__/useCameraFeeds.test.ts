import { describe, it, expect } from 'vitest';
import { mergeFeedStatus } from '@/hooks/useCameraFeeds';
import { CameraFeed } from '@/types/stream';

const feedA: CameraFeed = {
  id: '43', name: 'Cam A', department: 'Traffic', location: '0,0',
  lat: 0, long: 0, hlsUrl: 'https://example.com/a.m3u8', status: 'UNKNOWN',
};
const feedB: CameraFeed = {
  id: '44', name: 'Cam B', department: 'Traffic', location: '0,0',
  lat: 0, long: 0, hlsUrl: 'https://example.com/b.m3u8', status: 'UNKNOWN',
};

describe('mergeFeedStatus', () => {
  it('keeps the same object reference for a feed whose resolved status did not change', () => {
    const first = mergeFeedStatus([feedA, feedB], { '43': true, '44': false });
    const second = mergeFeedStatus(first, { '43': true, '44': false });

    expect(second[0]).toBe(first[0]); // feedA: still ONLINE both times -- same reference
    expect(second[1]).toBe(first[1]); // feedB: still OFFLINE both times -- same reference
  });

  it('allocates a new object only for the feed whose status actually changed', () => {
    const first = mergeFeedStatus([feedA, feedB], { '43': true, '44': false });
    const second = mergeFeedStatus(first, { '43': true, '44': true }); // B flipped OFFLINE -> ONLINE

    expect(second[0]).toBe(first[0]); // A unchanged -- same reference
    expect(second[1]).not.toBe(first[1]); // B changed -- new reference
    expect(second[1].status).toBe('ONLINE');
  });

  it('leaves DEGRADED feeds alone regardless of reachability', () => {
    const degraded: CameraFeed = { ...feedA, status: 'DEGRADED' };
    const result = mergeFeedStatus([degraded], { '43': true });
    expect(result[0]).toBe(degraded);
  });

  it('leaves a feed with no reachability result yet unchanged', () => {
    const result = mergeFeedStatus([feedA], {});
    expect(result[0]).toBe(feedA);
  });
});
