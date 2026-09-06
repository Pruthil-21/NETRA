import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import DashboardPage from '@/app/page';

// This suite proves the fix for a regression where jumping to a camera from a live
// alert ("View Camera") never touched `treeSelection`. Before the tree was made a pure
// filter (see dashboardTreeFilter.ts's null -> all-feeds contract), the grid was gated
// on making a District/Circle selection at all, so the jump either landed on an empty
// state or silently fell back to showing the first camera in whatever district/circle
// happened to be selected (wrong camera, no error) -- see handleSelectFocus in app/page.tsx.

const FEEDS = [
  { id: '1', name: 'Anand Junction Cam', department: 'Anand', location: '', lat: 0, long: 0, hlsUrl: '', status: 'ONLINE' as const },
  { id: '2', name: 'Vadodara Highway Cam', department: 'Vadodara', location: '', lat: 0, long: 0, hlsUrl: '', status: 'ONLINE' as const },
];

vi.mock('@/hooks/useCameraFeeds', () => ({
  useCameraFeeds: () => ({
    feeds: FEEDS,
    loading: false,
    error: null,
    refetch: vi.fn(),
    lastUpdated: new Date(),
  }),
  FEED_STALE_THRESHOLD_MS: 15000,
}));

vi.mock('@/context/CameraRegistryContext', () => ({
  useCameraRegistry: () => ({ cameras: [] }),
}));

vi.mock('@/services/circlesService', () => ({
  circlesService: { listCircles: () => Promise.resolve([]) },
}));

// Stand-in for the real AlertBanner (which polls a live API on its own) -- exposes a
// button that fires onJumpToCamera exactly the way the real "View Camera" button does.
vi.mock('@/components/AlertBanner', () => ({
  AlertBanner: ({ onJumpToCamera }: { onJumpToCamera?: (id: string) => void }) => (
    <button onClick={() => onJumpToCamera?.('2')}>Mock View Camera</button>
  ),
}));

describe('Dashboard: alert "Jump to Camera" vs. the tree-selection gate', () => {
  it('shows every registered camera by default, then narrows to the jumped-to camera', () => {
    render(<DashboardPage />);

    // Nothing selected in the tree yet -- the tree is a filter, not a gate, so both
    // cameras are already visible.
    expect(screen.getByText('Anand Junction Cam')).toBeInTheDocument();
    expect(screen.getByText('Vadodara Highway Cam')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Mock View Camera'));

    // The jump switches to focus layout, which shows exactly the target camera.
    expect(screen.queryByText('Anand Junction Cam')).not.toBeInTheDocument();
    expect(screen.getByText('Vadodara Highway Cam')).toBeInTheDocument();
  });

  it('re-selects the target camera\'s district even when a different district/circle was already selected', () => {
    render(<DashboardPage />);

    // Select Anand's district first, same as clicking it in the tree.
    fireEvent.click(screen.getByText('Anand'));
    expect(screen.getByText('Anand Junction Cam')).toBeInTheDocument();
    expect(screen.queryByText('Vadodara Highway Cam')).not.toBeInTheDocument();

    // Jump to camera 2, which lives in Vadodara, not the currently-selected Anand.
    fireEvent.click(screen.getByText('Mock View Camera'));

    // Must show the actually jumped-to camera, not silently fall back to whatever
    // was first in the (now-stale) Anand-filtered list.
    expect(screen.getByText('Vadodara Highway Cam')).toBeInTheDocument();
  });
});
