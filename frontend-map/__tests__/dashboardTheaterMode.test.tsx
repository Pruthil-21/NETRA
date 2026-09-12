import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React, { useState } from 'react';
import type { CameraFeed } from '@/types/stream';
import { CAMERA_DRAG_MIME } from '@/lib/cameraDrag';

// Same jsdom DataTransfer stand-in as cameraTreeDragToWatch.test.tsx.
function fakeDataTransfer() {
  const store: Record<string, string> = {};
  return {
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? '',
    get types() {
      return Object.keys(store);
    },
    effectAllowed: '',
  } as unknown as DataTransfer;
}

const FEEDS: CameraFeed[] = [
  { id: '101', name: 'Anand Junction Cam', department: 'Anand', location: '', lat: 0, long: 0, hlsUrl: '', status: 'ONLINE' },
];

vi.mock('@/hooks/useCameraFeeds', () => ({
  useCameraFeeds: () => ({ feeds: FEEDS, loading: false, error: null, refetch: vi.fn(), lastUpdated: new Date() }),
  FEED_STALE_THRESHOLD_MS: 15000,
}));

vi.mock('@/context/CameraRegistryContext', () => ({
  useCameraRegistry: () => ({ cameras: [] }),
  HEALTH_CHECK_INTERVAL_MS: 20000,
}));

vi.mock('@/services/areasService', () => ({
  areasService: { listAreas: () => Promise.resolve([]) },
}));

vi.mock('@/components/AlertBanner', () => ({
  AlertBanner: () => <div>Mock Alert Banner</div>,
}));

const setImmersive = vi.fn();
vi.mock('@/context/ImmersiveModeContext', () => ({
  useImmersiveMode: () => ({ isImmersive: false, setImmersive }),
}));

// Fullscreen isn't implemented in jsdom -- a real (React-backed) fake here,
// not a static stub, so toggle() genuinely re-renders the page and the
// "sidebar disappears once fullscreen, not before" behavior is provable.
vi.mock('@/hooks/useFullscreen', () => ({
  useFullscreen: () => {
    const [isFullscreen, setIsFullscreen] = useState(false);
    return {
      isFullscreen,
      enter: () => setIsFullscreen(true),
      exit: () => setIsFullscreen(false),
      toggle: () => setIsFullscreen((v) => !v),
    };
  },
}));

function dragCameraIntoGrid(dataTransfer: DataTransfer) {
  const dropTarget = screen.getByText('Anand Junction Cam').closest('[class*="rounded-lg"]') as HTMLElement;
  fireEvent.dragOver(dropTarget, { dataTransfer });
  fireEvent.drop(dropTarget, { dataTransfer });
}

describe('Dashboard theater mode (drag-composed watch grid)', () => {
  it('dragging a camera in hides nav/alerts/controls but keeps the camera registry sidebar', async () => {
    const DashboardPage = (await import('@/app/page')).default;
    render(<DashboardPage />);

    // Normal mode: full chrome present.
    expect(screen.getByText('Live Operations Feeds')).toBeInTheDocument();
    expect(screen.getByText('Mock Alert Banner')).toBeInTheDocument();
    expect(screen.getByLabelText('Play All')).toBeInTheDocument();
    expect(screen.getByText('Gujarat')).toBeInTheDocument(); // sidebar tree root

    const dataTransfer = fakeDataTransfer();
    dataTransfer.setData(CAMERA_DRAG_MIME, JSON.stringify([101]));
    dragCameraIntoGrid(dataTransfer);

    // Theater mode: page-level chrome gone, but the registry sidebar stays --
    // it's the only way left to drag in more cameras without exiting first.
    expect(screen.queryByText('Live Operations Feeds')).not.toBeInTheDocument();
    expect(screen.queryByText('Mock Alert Banner')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Play All')).not.toBeInTheDocument();
    expect(screen.getByText('Gujarat')).toBeInTheDocument();

    expect(screen.getByText('Exit custom view')).toBeInTheDocument();
    expect(screen.getByLabelText('Enter fullscreen')).toBeInTheDocument();
    expect(setImmersive).toHaveBeenCalledWith(true);
  });

  it('going fullscreen additionally hides the camera registry sidebar', async () => {
    const DashboardPage = (await import('@/app/page')).default;
    render(<DashboardPage />);

    const dataTransfer = fakeDataTransfer();
    dataTransfer.setData(CAMERA_DRAG_MIME, JSON.stringify([101]));
    dragCameraIntoGrid(dataTransfer);
    expect(screen.getByText('Gujarat')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Enter fullscreen'));

    expect(screen.queryByText('Gujarat')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Exit fullscreen')).toBeInTheDocument();

    // Backing out of fullscreen brings the sidebar right back.
    fireEvent.click(screen.getByLabelText('Exit fullscreen'));
    expect(screen.getByText('Gujarat')).toBeInTheDocument();
  });

  it('exiting custom view restores the normal chrome', async () => {
    const DashboardPage = (await import('@/app/page')).default;
    render(<DashboardPage />);

    const dataTransfer = fakeDataTransfer();
    dataTransfer.setData(CAMERA_DRAG_MIME, JSON.stringify([101]));
    dragCameraIntoGrid(dataTransfer);

    fireEvent.click(screen.getByText('Exit custom view'));

    expect(screen.getByText('Live Operations Feeds')).toBeInTheDocument();
    expect(setImmersive).toHaveBeenCalledWith(false);
  });
});
