import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import ArchivePage from '@/app/archive/page';
import { fetchRecordingSegments } from '@/services/recordingsService';

// Regression coverage for a real bug: clicking "View Footage" on a second,
// different alert (a fresh /archive?camera=..&at=.. navigation into this
// same already-mounted page) was silently ignored -- both the camera pick
// and the seek target were "apply once, ever" flags/state, so every alert
// after the first kept landing back on whatever camera/moment was first
// deep-linked. See app/archive/page.tsx's requestedCameraId/requestedAt
// effects for the fix (tracked by the URL value itself, not a boolean).
const { mockSearchParams, setSearchParams } = vi.hoisted(() => {
  let params = new URLSearchParams();
  return {
    mockSearchParams: () => params,
    setSearchParams: (next: URLSearchParams) => {
      params = next;
    },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/archive',
  useSearchParams: () => mockSearchParams(),
}));

const CAMERA_1 = {
  id: 1, name: 'Camera One', dept: 'Ahmedabad', area_id: null, lat: 23.03, long: 72.58,
  camera_type: 'Bullet', ownership: 'Traffic Police', connectivity_status: 'online',
  storage_type: 'Cloud', retention_days: 30, health_status: 'operational', rtsp_url: '',
};
const CAMERA_2 = {
  id: 2, name: 'Camera Two', dept: 'Anand', area_id: null, lat: 22.56, long: 72.94,
  camera_type: 'Bullet', ownership: 'Traffic Police', connectivity_status: 'online',
  storage_type: 'Cloud', retention_days: 30, health_status: 'operational', rtsp_url: '',
};

vi.mock('@/context/CameraRegistryContext', () => ({
  useCameraRegistry: () => ({
    cameras: [CAMERA_1, CAMERA_2],
    isLoading: false,
    error: null,
    lastUpdated: new Date(),
    refreshCameras: vi.fn(),
  }),
  HEALTH_CHECK_INTERVAL_MS: 20000,
}));

vi.mock('@/hooks/usePermissions', () => ({
  usePermissions: () => ({ scopeValue: null, has: () => false }),
}));

vi.mock('@/services/areasService', () => ({
  areasService: { listAreas: () => Promise.resolve([]) },
}));

vi.mock('@/services/recordingsService', async () => {
  const actual = await vi.importActual<typeof import('@/services/recordingsService')>('@/services/recordingsService');
  return { ...actual, fetchRecordingSegments: vi.fn() };
});

function segmentsFor(camId: number, dateIso: string, duration = 3600) {
  return { available: true, segments: [{ start: dateIso, duration, url: `https://playback.example/cam${camId}` }], service_reachable: true };
}

describe('Archive "View Footage" deep link (?camera=&at=)', () => {
  beforeEach(() => {
    vi.mocked(fetchRecordingSegments).mockReset();
  });

  it('a second View Footage click for a different camera actually switches cameras, not stuck on the first', async () => {
    setSearchParams(new URLSearchParams({ camera: '1', at: '2026-09-05T08:02:00.000Z' }));
    vi.mocked(fetchRecordingSegments).mockResolvedValue(segmentsFor(1, '2026-09-05T08:00:00.000Z'));

    const { rerender } = render(<ArchivePage />);
    expect(await screen.findByText('Archive — Camera One')).toBeInTheDocument();

    // A fresh "View Footage" click on a different alert, on a different camera.
    setSearchParams(new URLSearchParams({ camera: '2', at: '2026-09-06T08:02:00.000Z' }));
    vi.mocked(fetchRecordingSegments).mockResolvedValue(segmentsFor(2, '2026-09-06T08:00:00.000Z'));
    rerender(<ArchivePage />);

    expect(await screen.findByText('Archive — Camera Two')).toBeInTheDocument();
  });

  it('a second View Footage click for the same camera but a different moment still re-seeks', async () => {
    setSearchParams(new URLSearchParams({ camera: '1', at: '2026-09-05T08:02:00.000Z' }));
    vi.mocked(fetchRecordingSegments).mockResolvedValue(segmentsFor(1, '2026-09-05T08:00:00.000Z', 7200));

    const { rerender } = render(<ArchivePage />);
    await screen.findByText('Archive — Camera One');
    await waitFor(() => expect(screen.getByLabelText('Scrub recorded footage timeline')).toHaveAttribute('aria-valuenow', '110'));

    // Same camera, a different alert an hour later in the same day's footage.
    setSearchParams(new URLSearchParams({ camera: '1', at: '2026-09-05T09:02:00.000Z' }));
    rerender(<ArchivePage />);

    await waitFor(() => expect(screen.getByLabelText('Scrub recorded footage timeline')).toHaveAttribute('aria-valuenow', '3710'));
  });
});
