import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AlertsPage from '@/app/alerts/page';
import { alertsService } from '@/services/alertsService';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { usePermissions } from '@/hooks/usePermissions';
import { useAlertsStream } from '@/hooks/useAlertsStream';

// Right-click "View Alerts for this Camera" (CameraContextMenu) lands here
// as /alerts?camera=<id> -- this covers that the page actually narrows down
// to the requested camera instead of showing every alert city-grouped, and
// that clearing the filter goes back to the unfiltered view.
const { pushMock, mockSearchParams, setSearchParams } = vi.hoisted(() => {
  let params = new URLSearchParams();
  return {
    pushMock: vi.fn(),
    mockSearchParams: () => params,
    setSearchParams: (next: URLSearchParams) => {
      params = next;
    },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  useSearchParams: () => mockSearchParams(),
}));

vi.mock('@/services/alertsService', () => ({
  alertsService: { list: vi.fn(), updateStatus: vi.fn(), history: vi.fn() },
}));
vi.mock('@/context/CameraRegistryContext', () => ({ useCameraRegistry: vi.fn() }));
vi.mock('@/hooks/usePermissions', () => ({ usePermissions: vi.fn() }));
vi.mock('@/hooks/useAlertsStream', () => ({ useAlertsStream: vi.fn() }));
vi.mock('@/components/alerts/TrafficAlertsSection', () => ({
  TrafficAlertsSection: ({ cameraId }: { cameraId?: number | null }) => (
    <div data-testid="traffic-section">traffic cameraId={String(cameraId)}</div>
  ),
}));
vi.mock('@/components/alerts/AddToWatchlistModal', () => ({ AddToWatchlistModal: () => null }));

// IDs 1-30 are the reserved organizer range (see lib/cameraCity.ts's
// ORGANIZER_CAMERA_CITY) -- a fixed id -> real-city map that would silently
// override whatever `dept` these fixtures set, so both use ids well outside
// it to keep the city grouping this test actually exercises predictable.
const CAMERA_A = {
  id: 112, name: 'Anand Junction Cam', dept: 'Anand', lat: 22.56, long: 72.94,
  camera_type: 'Bullet', ownership: 'Traffic Police', connectivity_status: 'online',
  storage_type: 'Cloud', retention_days: 30, health_status: 'operational', rtsp_url: '',
};
const CAMERA_B = {
  id: 113, name: 'Vadodara Circle Cam', dept: 'Vadodara', lat: 22.3, long: 73.2,
  camera_type: 'Bullet', ownership: 'Traffic Police', connectivity_status: 'online',
  storage_type: 'Cloud', retention_days: 30, health_status: 'operational', rtsp_url: '',
};

const ALERT_A = {
  id: 1, camera_id: 112, plate_number: 'GJ01AB1234', watchlist_id: 1, detection_id: null,
  matched_at: new Date().toISOString(), status: 'NEW' as const,
};
const ALERT_B = {
  id: 2, camera_id: 113, plate_number: 'GJ05CD5678', watchlist_id: 2, detection_id: null,
  matched_at: new Date().toISOString(), status: 'NEW' as const,
};

describe('AlertsPage camera filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSearchParams(new URLSearchParams());
    (useCameraRegistry as any).mockReturnValue({ cameras: [CAMERA_A, CAMERA_B] });
    (usePermissions as any).mockReturnValue({ scopeValue: null, permissions: ['view_analytics'] });
    (useAlertsStream as any).mockImplementation(() => {});
    (alertsService.list as any).mockResolvedValue([ALERT_A, ALERT_B]);
  });

  it('shows every camera\'s alerts, grouped by city, with no filter applied', async () => {
    render(<AlertsPage />);
    await waitFor(() => expect(alertsService.list).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('Anand'));
    fireEvent.click(await screen.findByText('Vadodara'));
    expect(screen.getByText('GJ01AB1234')).toBeInTheDocument();
    expect(screen.getByText('GJ05CD5678')).toBeInTheDocument();
    expect(screen.queryByText(/Filtered to/)).not.toBeInTheDocument();
  });

  it('narrows to one camera\'s alerts and shows a clearable filter banner when ?camera= is set', async () => {
    setSearchParams(new URLSearchParams('camera=112'));
    render(<AlertsPage />);
    await waitFor(() => expect(alertsService.list).toHaveBeenCalled());

    expect(await screen.findByText(/Filtered to/)).toBeInTheDocument();
    expect(screen.getByText('Anand Junction Cam', { selector: 'span' })).toBeInTheDocument();
    fireEvent.click(await screen.findByText('Anand'));
    expect(screen.getByText('GJ01AB1234')).toBeInTheDocument();
    expect(screen.queryByText('GJ05CD5678')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Clear camera filter'));
    expect(pushMock).toHaveBeenCalledWith('/alerts');
  });

  it('forwards the same camera filter to the traffic tab', () => {
    setSearchParams(new URLSearchParams('camera=112'));
    render(<AlertsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Traffic' }));
    expect(screen.getByTestId('traffic-section')).toHaveTextContent('cameraId=112');
  });
});
