import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AlertsBell } from '@/components/alerts/AlertsBell';

const CAMERA = {
  id: 7, name: 'Ring Road Cam', dept: 'Traffic Police', lat: 23.03, long: 72.58,
  camera_type: 'Bullet', ownership: 'Traffic Police', connectivity_status: 'online',
  storage_type: 'Cloud', retention_days: 30, health_status: 'operational', rtsp_url: '',
};

const ALERT = {
  id: 1, camera_id: 7, plate_number: 'GJ01AB1234', watchlist_id: 3, detection_id: null,
  matched_at: new Date().toISOString(), status: 'NEW' as const,
  nearest_station: { name: 'Ring Road Police Station', distance_meters: 850 },
};

vi.mock('@/context/CameraRegistryContext', () => ({
  useCameraRegistry: () => ({ cameras: [CAMERA] }),
}));

vi.mock('@/lib/geolocation', () => ({
  useGeolocation: () => ({ status: 'ready', position: { lat: 23.03, long: 72.58 } }),
}));

vi.mock('@/services/alertsService', () => ({
  alertsService: { list: () => Promise.resolve([ALERT]) },
}));

describe('AlertsBell', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the accurate nearest-station distance on a nearby alert', async () => {
    render(<AlertsBell />);
    fireEvent.click(screen.getByRole('button', { name: /nearby alerts/i }));

    await waitFor(() => expect(screen.getByText('GJ01AB1234')).toBeInTheDocument());
    expect(screen.getByText(/Ring Road Police Station/)).toBeInTheDocument();
    expect(screen.getByText(/850m/)).toBeInTheDocument();
  });
});
