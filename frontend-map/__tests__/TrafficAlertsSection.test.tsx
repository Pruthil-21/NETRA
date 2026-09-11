import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TrafficAlertsSection } from '@/components/alerts/TrafficAlertsSection';
import { trafficAlertsService } from '@/services/trafficAlertsService';
import { usePermissions } from '@/hooks/usePermissions';
import { useAlertsStream } from '@/hooks/useAlertsStream';
import { useCameraRegistry } from '@/context/CameraRegistryContext';

vi.mock('@/services/trafficAlertsService', () => ({
  trafficAlertsService: { list: vi.fn(), updateStatus: vi.fn() },
}));
vi.mock('@/hooks/usePermissions', () => ({ usePermissions: vi.fn() }));
vi.mock('@/hooks/useAlertsStream', () => ({ useAlertsStream: vi.fn() }));
vi.mock('@/context/CameraRegistryContext', () => ({ useCameraRegistry: vi.fn() }));

const FLOW_ALERT = {
  id: 5, alert_type: 'flow' as const, camera_id: null, from_camera_id: 3, to_camera_id: 9,
  metric_value: 4.2, threshold_value: 10, district: 'Anand', status: 'NEW' as const,
  triggered_at: new Date().toISOString(), acknowledged_by: null, acknowledged_at: null,
};

const OFFLINE_ALERT = {
  id: 7, alert_type: 'camera_offline' as const, camera_id: 42, from_camera_id: null, to_camera_id: null,
  metric_value: 45, threshold_value: 30, district: 'Junagadh', status: 'NEW' as const,
  triggered_at: new Date().toISOString(), acknowledged_by: null, acknowledged_at: null,
};

function mockPermissions(permissions: string[]) {
  (usePermissions as any).mockReturnValue({ permissions, loading: false });
}

describe('TrafficAlertsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useAlertsStream as any).mockImplementation(() => {});
    (useCameraRegistry as any).mockReturnValue({ cameras: [] });
  });

  it('loads NEW alerts by default and renders a corridor alert grouped by district', async () => {
    mockPermissions(['view_analytics']);
    (trafficAlertsService.list as any).mockResolvedValue([FLOW_ALERT]);
    render(<TrafficAlertsSection />);

    await waitFor(() => expect(trafficAlertsService.list).toHaveBeenCalledWith('NEW'));
    expect(await screen.findByText(/Camera 3 → Camera 9/)).toBeInTheDocument();
    expect(screen.getByText('Anand', { exact: false })).toBeInTheDocument();
  });

  it('switching to All refetches without a status filter', async () => {
    mockPermissions(['view_analytics']);
    (trafficAlertsService.list as any).mockResolvedValue([FLOW_ALERT]);
    render(<TrafficAlertsSection />);
    await waitFor(() => expect(trafficAlertsService.list).toHaveBeenCalledWith('NEW'));

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(trafficAlertsService.list).toHaveBeenLastCalledWith(undefined));
  });

  it('selecting an alert shows its detail panel with action buttons', async () => {
    mockPermissions(['view_analytics', 'acknowledge_alerts']);
    (trafficAlertsService.list as any).mockResolvedValue([FLOW_ALERT]);
    render(<TrafficAlertsSection />);

    fireEvent.click(await screen.findByText(/Camera 3 → Camera 9/));
    expect(await screen.findByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('acknowledging a NEW alert removes it from the NEW-filtered list', async () => {
    mockPermissions(['view_analytics', 'acknowledge_alerts']);
    (trafficAlertsService.list as any).mockResolvedValue([FLOW_ALERT]);
    (trafficAlertsService.updateStatus as any).mockResolvedValue({ ...FLOW_ALERT, status: 'ACKNOWLEDGED' });
    render(<TrafficAlertsSection />);

    fireEvent.click(await screen.findByText(/Camera 3 → Camera 9/));
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(trafficAlertsService.updateStatus).toHaveBeenCalledWith(5, 'ACKNOWLEDGED'));
    await waitFor(() => expect(screen.queryByText(/Camera 3 → Camera 9/)).not.toBeInTheDocument());
  });

  it('hides action buttons without acknowledge_alerts', async () => {
    mockPermissions(['view_analytics']);
    (trafficAlertsService.list as any).mockResolvedValue([FLOW_ALERT]);
    render(<TrafficAlertsSection />);

    fireEvent.click(await screen.findByText(/Camera 3 → Camera 9/));
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
  });

  it('renders a camera_offline alert with its own icon, label, and reading text', async () => {
    mockPermissions(['view_analytics']);
    (trafficAlertsService.list as any).mockResolvedValue([OFFLINE_ALERT]);
    render(<TrafficAlertsSection />);

    fireEvent.click(await screen.findByText('Camera 42'));
    expect(screen.getByText(/Camera offline/)).toBeInTheDocument();
    expect(screen.getByText(/Offline for 45 min \(threshold 30 min\)/)).toBeInTheDocument();
  });

  it('filters the list down to one camera when cameraId is supplied', async () => {
    mockPermissions(['view_analytics']);
    (trafficAlertsService.list as any).mockResolvedValue([FLOW_ALERT, OFFLINE_ALERT]);
    render(<TrafficAlertsSection cameraId={42} />);

    expect(await screen.findByText('Camera 42')).toBeInTheDocument();
    expect(screen.queryByText(/Camera 3 → Camera 9/)).not.toBeInTheDocument();
  });
});
