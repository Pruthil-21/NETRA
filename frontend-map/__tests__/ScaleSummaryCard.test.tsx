import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScaleSummaryCard } from '@/components/scale/ScaleSummaryCard';

describe('ScaleSummaryCard', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the summary counts and the simulation label', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          total: 80030, online: 68025, degraded: 8003, offline: 4002,
          real_stream_count: 30, synthetic_count: 80000, edge_node_count: 800,
        }),
      })
    );

    render(<ScaleSummaryCard />);

    await waitFor(() => expect(screen.getByText('80,030')).toBeInTheDocument());
    expect(screen.getByText('800')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
    expect(screen.getByText(/simulation/i)).toBeInTheDocument();
  });

  it('shows a degraded-service message on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    render(<ScaleSummaryCard />);
    await waitFor(() => expect(screen.getByText(/unavailable/i)).toBeInTheDocument());
  });
});
