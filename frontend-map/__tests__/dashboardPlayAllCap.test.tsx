import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import type { CameraFeed } from '@/types/stream';

// Regression coverage for two Play-All bugs (see app/page.tsx's Play-All
// effect):
//  1. Opening every visible feed (not just MAX_CONCURRENT_PLAYERS worth) let
//     useLimitedPlayers' own eviction decide which six ended up active --
//     whichever six were opened *last* -- leaving the front of the grid
//     stuck on a permanent "Queued" placeholder even though that had
//     nothing to do with those tiles never having been opened.
//  2. TEST_FEEDS-style entries (e.g. "xiaomi-camera") have a non-numeric
//     string id -- Number(id) on those is NaN, which could occupy one of
//     the six player slots and never resolve back to a real feed.
//
// Each test needs a different useCameraFeeds() return value, so the module
// graph is reloaded fresh (vi.resetModules + a dynamic import of app/page
// after vi.doMock) rather than a single hoisted vi.mock shared file-wide.

function makeFeed(id: string, department = 'Anand'): CameraFeed {
  return {
    id, name: `Camera ${id}`, department, location: '', lat: 0, long: 0,
    hlsUrl: `https://example.test/${id}/index.m3u8`, status: 'ONLINE',
  };
}

vi.mock('@/context/CameraRegistryContext', () => ({
  useCameraRegistry: () => ({ cameras: [] }),
}));

vi.mock('@/services/circlesService', () => ({
  circlesService: { listCircles: () => Promise.resolve([]) },
}));

vi.mock('@/components/AlertBanner', () => ({
  AlertBanner: () => null,
}));

beforeEach(() => {
  vi.resetModules();
});

describe('Dashboard Play-All: concurrency cap and NaN-id guard', () => {
  it('opens only the first MAX_CONCURRENT_PLAYERS (6) feeds, leaving the rest genuinely queued', async () => {
    const feeds = Array.from({ length: 8 }, (_, i) => makeFeed(String(i + 1)));
    vi.doMock('@/hooks/useCameraFeeds', () => ({
      useCameraFeeds: () => ({ feeds, loading: false, error: null, refetch: vi.fn(), lastUpdated: new Date() }),
      FEED_STALE_THRESHOLD_MS: 15000,
    }));
    const { default: DashboardPage } = await import('@/app/page');
    render(<DashboardPage />);

    fireEvent.click(screen.getByText('Anand'));
    fireEvent.click(screen.getByLabelText('Play All'));

    await waitFor(() => expect(screen.getAllByTestId('hls-player')).toHaveLength(6));
    // The remaining two are queued, not silently dropped or stuck without explanation.
    expect(screen.getAllByText('Queued — waiting for a free decoder slot')).toHaveLength(2);
  });

  it('does not let a non-numeric feed id (e.g. "xiaomi-camera") occupy a player slot', async () => {
    // A made-up department (not "Streaming Test Rig", which is where the
    // real TEST_FEEDS constant's own "xiaomi-camera" entry lives -- using a
    // different name here keeps this test isolated from that fixed array).
    // 5 real numeric feeds + one non-numeric-id feed = 6 total, at/under the
    // cap, so this isolates the NaN-guard specifically (not the cap).
    const feeds = [
      ...Array.from({ length: 5 }, (_, i) => makeFeed(String(i + 1), 'QA District')),
      makeFeed('zeta-camera', 'QA District'),
    ];
    vi.doMock('@/hooks/useCameraFeeds', () => ({
      useCameraFeeds: () => ({ feeds, loading: false, error: null, refetch: vi.fn(), lastUpdated: new Date() }),
      FEED_STALE_THRESHOLD_MS: 15000,
    }));
    const { default: DashboardPage } = await import('@/app/page');
    render(<DashboardPage />);

    fireEvent.click(screen.getByText('QA District'));
    fireEvent.click(screen.getByLabelText('Play All'));

    await waitFor(() => expect(screen.getAllByTestId('hls-player')).toHaveLength(5));
    // The non-numeric-id feed never gets a player -- it stays queued, and no
    // player slot got silently wasted on a NaN id.
    expect(screen.getAllByText('Queued — waiting for a free decoder slot')).toHaveLength(1);
  });
});
