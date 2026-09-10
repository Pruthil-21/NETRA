import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TrafficTrendsSection } from '@/components/reports/TrafficTrendsSection';
import { trafficAnalyticsService } from '@/services/trafficAnalyticsService';

vi.mock('@/services/trafficAnalyticsService', () => ({
  trafficAnalyticsService: { fetchDensityTrend: vi.fn(), fetchFlowTrend: vi.fn() },
}));

const DENSITY_TREND = {
  trend: [{ bucket_start: '2026-09-01T00:00:00', count: 12 }],
  top_cameras: [{ camera_id: 4, count: 12 }],
};
const FLOW_TREND = {
  trend: [{ bucket_start: '2026-09-01T00:00:00', count: 3 }],
  top_corridors: [{ from_camera_id: 4, to_camera_id: 9, transitions: 3, avg_speed_kmh: 22.5 }],
};

describe('TrafficTrendsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (trafficAnalyticsService.fetchDensityTrend as any).mockResolvedValue(DENSITY_TREND);
    (trafficAnalyticsService.fetchFlowTrend as any).mockResolvedValue(FLOW_TREND);
  });

  it('loads both trends on mount with a daily bucket by default', async () => {
    render(<TrafficTrendsSection />);
    await waitFor(() => expect(trafficAnalyticsService.fetchDensityTrend).toHaveBeenCalledTimes(1));
    const call = (trafficAnalyticsService.fetchDensityTrend as any).mock.calls[0][0];
    expect(call.bucket).toBe('day');
    expect(trafficAnalyticsService.fetchFlowTrend).toHaveBeenCalledTimes(1);
  });

  it('renders the busiest camera and corridor from the loaded trends', async () => {
    render(<TrafficTrendsSection />);
    expect(await screen.findByText('Camera 4')).toBeInTheDocument();
    expect(screen.getByText(/Cam 4 → 9/)).toBeInTheDocument();
    expect(screen.getByText(/22\.5 km\/h/)).toBeInTheDocument();
  });

  it('switching to Hourly and clicking Apply refetches with bucket=hour', async () => {
    render(<TrafficTrendsSection />);
    await waitFor(() => expect(trafficAnalyticsService.fetchDensityTrend).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Hourly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(trafficAnalyticsService.fetchDensityTrend).toHaveBeenCalledTimes(2));
    const lastCall = (trafficAnalyticsService.fetchDensityTrend as any).mock.calls[1][0];
    expect(lastCall.bucket).toBe('hour');
  });

  it('surfaces a fetch failure as an error message', async () => {
    (trafficAnalyticsService.fetchDensityTrend as any).mockRejectedValue(new Error('boom'));
    render(<TrafficTrendsSection />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
