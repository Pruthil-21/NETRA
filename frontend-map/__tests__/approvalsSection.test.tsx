import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { ApprovalsSection } from '@/app/admin/ApprovalsSection';

const MOCK_REQUEST = {
  id: 1, officer_id: 5, badge_number: 'GJ-REG-001', name: 'New Recruit', rank: null,
  department: 'Traffic', contact_info: 'recruit@example.com', status: 'pending',
  reviewed_by: null, reviewed_at: null, rejection_reason: null, created_at: '2026-09-01T10:00:00Z',
};

describe('ApprovalsSection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a pending registration request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [MOCK_REQUEST] }));
    render(<ApprovalsSection />);
    await waitFor(() => expect(screen.getByText('New Recruit')).toBeInTheDocument());
    expect(screen.getByText('GJ-REG-001')).toBeInTheDocument();
  });

  it('approves a request with a role and scope', async () => {
    const approveSpy = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ...MOCK_REQUEST, status: 'approved' }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, opts?: RequestInit) => {
        if (url.includes('/approve')) return approveSpy(url, opts);
        return Promise.resolve({ ok: true, json: async () => [MOCK_REQUEST] });
      })
    );
    render(<ApprovalsSection />);
    await waitFor(() => expect(screen.getByText('New Recruit')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm approval/i }));

    await waitFor(() => expect(approveSpy).toHaveBeenCalled());
    const body = JSON.parse((approveSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.role_name).toBe('station_officer');
  });

  it('rejects a request with a reason', async () => {
    const rejectSpy = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ ...MOCK_REQUEST, status: 'rejected', rejection_reason: 'Bad badge' }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, opts?: RequestInit) => {
        if (url.includes('/reject')) return rejectSpy(url, opts);
        return Promise.resolve({ ok: true, json: async () => [MOCK_REQUEST] });
      })
    );
    render(<ApprovalsSection />);
    await waitFor(() => expect(screen.getByText('New Recruit')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    fireEvent.change(screen.getByPlaceholderText(/badge could not be verified/i), { target: { value: 'Bad badge' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm rejection/i }));

    await waitFor(() => expect(rejectSpy).toHaveBeenCalled());
  });
});
