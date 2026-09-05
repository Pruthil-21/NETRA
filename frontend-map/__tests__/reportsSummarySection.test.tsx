import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ReportsSummarySection } from '@/components/reports/ReportsSummarySection';

const SUMMARY = {
  total_cameras: 30,
  cameras_by_department: { 'Traffic Police': 20, Ahmedabad: 10 },
  cameras_by_connectivity_status: { online: 25, offline: 5 },
  cameras_by_health_status: { operational: 28, degraded: 2 },
  alerts_last_24h: 4,
  detections_last_24h: 120,
  blacklist_entries_last_24h: 1,
  avg_alert_response_seconds: 132,
};

describe('ReportsSummarySection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the registry overview and per-category breakdowns', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => SUMMARY }));
    render(<ReportsSummarySection />);

    await waitFor(() => expect(screen.getByText(/30 cameras across 2 departments/)).toBeInTheDocument());
    expect(screen.getByText('Traffic Police')).toBeInTheDocument();
    expect(screen.getByText('online')).toBeInTheDocument();
    expect(screen.getByText('operational')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('2m 12s')).toBeInTheDocument();
  });

  it('shows a dash for activity fields the backend reports as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ...SUMMARY,
          alerts_last_24h: null,
          detections_last_24h: null,
          blacklist_entries_last_24h: null,
          avg_alert_response_seconds: null,
        }),
      })
    );
    render(<ReportsSummarySection />);

    await waitFor(() => expect(screen.getAllByText('—').length).toBe(4));
  });

  it('shows an error message when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    render(<ReportsSummarySection />);
    await waitFor(() => expect(screen.getByText(/Registry API returned 500/)).toBeInTheDocument());
  });
});
