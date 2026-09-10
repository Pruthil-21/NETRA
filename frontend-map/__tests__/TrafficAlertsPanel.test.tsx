import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TrafficAlertsPanel } from '@/components/map/TrafficAlertsPanel';
import { trafficAlertsService } from '@/services/trafficAlertsService';
import { usePermissions } from '@/hooks/usePermissions';
import { useAlertsStream } from '@/hooks/useAlertsStream';

vi.mock('@/services/trafficAlertsService', () => ({
  trafficAlertsService: { list: vi.fn(), updateStatus: vi.fn() },
}));
vi.mock('@/hooks/usePermissions', () => ({ usePermissions: vi.fn() }));
vi.mock('@/hooks/useAlertsStream', () => ({ useAlertsStream: vi.fn() }));

const DENSITY_ALERT = {
  id: 1, alert_type: 'density' as const, camera_id: 7, from_camera_id: null, to_camera_id: null,
  metric_value: 62, threshold_value: 50, district: 'Ahmedabad', status: 'NEW' as const,
  triggered_at: new Date().toISOString(), acknowledged_by: null, acknowledged_at: null,
};

function mockPermissions(permissions: string[]) {
  (usePermissions as any).mockReturnValue({ permissions, loading: false });
}

describe('TrafficAlertsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useAlertsStream as any).mockImplementation(() => {});
  });

  it('renders nothing without view_analytics', async () => {
    mockPermissions([]);
    (trafficAlertsService.list as any).mockResolvedValue([DENSITY_ALERT]);
    const { container } = render(<TrafficAlertsPanel />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('renders nothing when there are no open alerts', async () => {
    mockPermissions(['view_analytics']);
    (trafficAlertsService.list as any).mockResolvedValue([]);
    const { container } = render(<TrafficAlertsPanel />);
    await waitFor(() => expect(trafficAlertsService.list).toHaveBeenCalledWith('NEW'));
    expect(container.firstChild).toBeNull();
  });

  it('shows a density alert and acknowledges it when permitted', async () => {
    mockPermissions(['view_analytics', 'acknowledge_alerts']);
    (trafficAlertsService.list as any).mockResolvedValue([DENSITY_ALERT]);
    (trafficAlertsService.updateStatus as any).mockResolvedValue({ ...DENSITY_ALERT, status: 'ACKNOWLEDGED' });
    render(<TrafficAlertsPanel />);

    expect(await screen.findByText(/Camera 7/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /acknowledge/i }));
    await waitFor(() => expect(trafficAlertsService.updateStatus).toHaveBeenCalledWith(1, 'ACKNOWLEDGED'));
    await waitFor(() => expect(screen.queryByText(/Camera 7/)).not.toBeInTheDocument());
  });

  it('hides acknowledge/dismiss actions without acknowledge_alerts', async () => {
    mockPermissions(['view_analytics']);
    (trafficAlertsService.list as any).mockResolvedValue([DENSITY_ALERT]);
    render(<TrafficAlertsPanel />);
    expect(await screen.findByText(/Camera 7/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /acknowledge/i })).not.toBeInTheDocument();
  });

  it('adds a live-pushed congestion alert and ignores watchlist-kind messages', async () => {
    mockPermissions(['view_analytics']);
    (trafficAlertsService.list as any).mockResolvedValue([]);
    let pushMessage: (msg: unknown) => void = () => {};
    (useAlertsStream as any).mockImplementation((cb: (msg: unknown) => void) => {
      pushMessage = cb;
    });
    render(<TrafficAlertsPanel />);
    await waitFor(() => expect(trafficAlertsService.list).toHaveBeenCalled());

    pushMessage({ kind: 'watchlist', id: 99, plate_number: 'GJ01AB1234' });
    expect(screen.queryByText(/Camera/)).not.toBeInTheDocument();

    pushMessage({ ...DENSITY_ALERT, id: 2, kind: 'congestion' });
    expect(await screen.findByText(/Camera 7/)).toBeInTheDocument();
  });
});
