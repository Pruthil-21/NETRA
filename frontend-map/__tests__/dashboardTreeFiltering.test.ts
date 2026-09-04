import { describe, it, expect } from 'vitest';
import type { CameraFeed } from '@/types/stream';
import type { Circle } from '@/services/circlesService';
import type { TreeSelection } from '@/components/tree/DistrictCircleTree';
import { filterFeedsByTreeSelection } from '@/lib/dashboardTreeFilter';

const FEEDS: CameraFeed[] = [
  { id: '1', name: 'Cam 1', department: 'Anand', location: '', lat: 0, long: 0, hlsUrl: '', status: 'ONLINE' },
  { id: '2', name: 'Cam 2', department: 'Anand', location: '', lat: 0, long: 0, hlsUrl: '', status: 'ONLINE' },
  { id: '3', name: 'Cam 3', department: 'Vadodara', location: '', lat: 0, long: 0, hlsUrl: '', status: 'ONLINE' },
];

const CIRCLES: Circle[] = [
  { id: 10, name: 'APC Circle', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
];

// Camera-id -> circle-id lookup, mirroring what the page builds from useCameraRegistry().cameras
const CIRCLE_BY_CAMERA_ID: Record<string, number | null> = { '1': 10, '2': null, '3': null };

describe('filterFeedsByTreeSelection', () => {
  it('returns an empty array when nothing is selected', () => {
    expect(filterFeedsByTreeSelection(FEEDS, null, CIRCLE_BY_CAMERA_ID)).toEqual([]);
  });

  it('returns every camera in the district (including unassigned) when a district is selected', () => {
    const result = filterFeedsByTreeSelection(FEEDS, { type: 'district', value: 'Anand' }, CIRCLE_BY_CAMERA_ID);
    expect(result.map((f) => f.id).sort()).toEqual(['1', '2']);
  });

  it('returns only that circle\'s cameras when a circle is selected', () => {
    const result = filterFeedsByTreeSelection(FEEDS, { type: 'circle', value: 10 }, CIRCLE_BY_CAMERA_ID);
    expect(result.map((f) => f.id)).toEqual(['1']);
  });
});
