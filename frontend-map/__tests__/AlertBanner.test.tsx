import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AlertBanner } from '@/components/AlertBanner';
import { alertsService } from '@/services/alertsService';

vi.mock('@/services/alertsService', () => ({
  alertsService: { list: vi.fn(), updateStatus: vi.fn() },
}));

function alert(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    camera_id: 7,
    plate_number: 'GJ01AB1234',
    watchlist_id: 3,
    detection_id: null,
    matched_at: new Date().toISOString(),
    status: 'NEW',
    nearest_station: { name: 'Ring Road Police Station', distance_meters: 850 },
    ...overrides,
  };
}

beforeEach(() => {
  sessionStorage.setItem('netra_session_token', 'fake-jwt-token');
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AlertBanner', () => {
  it('renders nothing when there are no alerts and the feed is healthy', async () => {
    (alertsService.list as any).mockResolvedValue([]);
    const { container } = render(<AlertBanner />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('shows a visible error strip when the alerts feed fails, instead of silently rendering nothing', async () => {
    (alertsService.list as any).mockRejectedValue(new Error('Failed to fetch alerts: Internal Server Error (500)'));
    render(<AlertBanner />);
    expect(await screen.findByText(/alerts feed unreachable/i)).toBeInTheDocument();
  });

  it('shows a distinct message for an auth failure', async () => {
    (alertsService.list as any).mockRejectedValue(new Error('Unauthorized (401)'));
    render(<AlertBanner />);
    expect(await screen.findByText(/not authorized/i)).toBeInTheDocument();
  });

  it('shows a network-failure message when the fetch itself throws', async () => {
    (alertsService.list as any).mockRejectedValue(new TypeError('Failed to fetch'));
    render(<AlertBanner />);
    expect(await screen.findByText(/alerts feed unreachable/i)).toBeInTheDocument();
  });

  it('shows the matched alert with its accurate nearest-station distance', async () => {
    (alertsService.list as any).mockResolvedValue([alert()]);
    render(<AlertBanner />);
    expect(await screen.findByText('GJ01AB1234')).toBeInTheDocument();
    expect(screen.getByText(/Ring Road Police Station/)).toBeInTheDocument();
    expect(screen.getByText(/850m/)).toBeInTheDocument();
  });

  it('clears the error strip once the feed recovers on a later poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let call = 0;
    (alertsService.list as any).mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error('Failed to fetch alerts: Service Unavailable (503)'));
      return Promise.resolve([]);
    });
    render(<AlertBanner />);
    await waitFor(() => expect(screen.getByText(/alerts feed unreachable/i)).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() => expect(screen.queryByText(/alerts feed unreachable/i)).not.toBeInTheDocument());
  });

  it('shows the newest alert first and pages through older ones with the arrows', async () => {
    const older = alert({ id: 1, plate_number: 'GJ01OLD001', matched_at: new Date(Date.now() - 60000).toISOString() });
    const newer = alert({ id: 2, plate_number: 'GJ01NEW002', matched_at: new Date().toISOString() });
    (alertsService.list as any).mockResolvedValue([older, newer]);
    render(<AlertBanner />);

    expect(await screen.findByText('GJ01NEW002')).toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Previous alert')).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Next alert'));
    expect(await screen.findByText('GJ01OLD001')).toBeInTheDocument();
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Next alert')).toBeDisabled();
  });

  it('the X button closes the overlay without changing the alert, and a genuinely new alert brings it back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = alert({ id: 1, plate_number: 'GJ01AB1234' });
    (alertsService.list as any).mockResolvedValue([first]);
    render(<AlertBanner />);
    expect(await screen.findByText('GJ01AB1234')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Close alert overlay'));
    expect(screen.queryByText('GJ01AB1234')).not.toBeInTheDocument();
    expect(alertsService.updateStatus).not.toHaveBeenCalled();

    const second = alert({ id: 2, plate_number: 'GJ01ZZ9999' });
    (alertsService.list as any).mockResolvedValue([first, second]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await screen.findByText('GJ01ZZ9999')).toBeInTheDocument();
  });

  it('Dismiss requires a non-blank reason and only then calls updateStatus with it', async () => {
    (alertsService.list as any).mockResolvedValue([alert()]);
    (alertsService.updateStatus as any).mockResolvedValue(alert({ status: 'DISMISSED' }));
    render(<AlertBanner />);
    await screen.findByText('GJ01AB1234');

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    const confirmButton = screen.getByRole('button', { name: /confirm/i });
    fireEvent.click(confirmButton);
    expect(await screen.findByText(/reason is required/i)).toBeInTheDocument();
    expect(alertsService.updateStatus).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText(/reason for dismissing/i), { target: { value: 'False positive, poor OCR read' } });
    fireEvent.click(confirmButton);
    await waitFor(() =>
      expect(alertsService.updateStatus).toHaveBeenCalledWith(1, 'DISMISSED', 'False positive, poor OCR read')
    );
  });

  it('Acknowledge needs no reason and removes the alert from the queue on success', async () => {
    (alertsService.list as any).mockResolvedValue([alert()]);
    (alertsService.updateStatus as any).mockResolvedValue(alert({ status: 'ACKNOWLEDGED' }));
    render(<AlertBanner />);
    await screen.findByText('GJ01AB1234');

    fireEvent.click(screen.getByRole('button', { name: /acknowledge/i }));
    await waitFor(() => expect(alertsService.updateStatus).toHaveBeenCalledWith(1, 'ACKNOWLEDGED', undefined));
    await waitFor(() => expect(screen.queryByText('GJ01AB1234')).not.toBeInTheDocument());
  });

  it('a failed action shows an error and does not remove the alert from the queue', async () => {
    (alertsService.list as any).mockResolvedValue([alert()]);
    (alertsService.updateStatus as any).mockRejectedValue(new Error('Failed to update alert: HTTP 500'));
    render(<AlertBanner />);
    await screen.findByText('GJ01AB1234');

    fireEvent.click(screen.getByRole('button', { name: /acknowledge/i }));
    expect(await screen.findByText(/failed to update alert/i)).toBeInTheDocument();
    expect(screen.getByText('GJ01AB1234')).toBeInTheDocument();
  });
});
