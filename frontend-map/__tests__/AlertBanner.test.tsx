import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AlertBanner } from '@/components/AlertBanner';

const NEW_ALERT = {
  id: 1,
  camera_id: 7,
  plate_number: 'GJ01AB1234',
  watchlist_id: 3,
  matched_at: new Date().toISOString(),
  status: 'NEW',
  nearest_station: { name: 'Ring Road Police Station', distance_meters: 850 },
};

beforeEach(() => {
  sessionStorage.setItem('netra_session_token', 'fake-jwt-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('AlertBanner', () => {
  it('renders nothing when there are no alerts and the feed is healthy', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => [] } as Response)));
    const { container } = render(<AlertBanner />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it('shows a visible error strip when the alerts feed fails, instead of silently rendering nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500 } as Response)));
    render(<AlertBanner />);
    expect(await screen.findByText(/alerts feed unavailable/i)).toBeInTheDocument();
  });

  it('shows a distinct message for an auth failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 401 } as Response)));
    render(<AlertBanner />);
    expect(await screen.findByText(/not authorized/i)).toBeInTheDocument();
  });

  it('shows a network-failure message when the fetch itself throws', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    render(<AlertBanner />);
    expect(await screen.findByText(/alerts feed unreachable/i)).toBeInTheDocument();
  });

  it('shows the matched alert with its accurate nearest-station distance', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => [NEW_ALERT] } as Response)));
    render(<AlertBanner />);
    expect(await screen.findByText('GJ01AB1234')).toBeInTheDocument();
    expect(screen.getByText(/Ring Road Police Station/)).toBeInTheDocument();
    expect(screen.getByText(/850m/)).toBeInTheDocument();
  });

  it('clears the error strip once the feed recovers on a later poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call += 1;
        if (call === 1) return Promise.resolve({ ok: false, status: 503 } as Response);
        return Promise.resolve({ ok: true, json: async () => [] } as Response);
      })
    );
    render(<AlertBanner />);
    await waitFor(() => expect(screen.getByText(/alerts feed unavailable/i)).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() => expect(screen.queryByText(/alerts feed unavailable/i)).not.toBeInTheDocument());
  });
});
