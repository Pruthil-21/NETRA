import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { PasswordResetRequestsSection } from '@/app/admin/PasswordResetRequestsSection';

const PENDING_REQUEST = {
  id: 1, officer_id: 5, badge_number: 'GJ-SO-001', officer_name: 'Demo Station Officer', rank: 'PI',
  role_name: 'station_officer', scope_type: 'district', scope_value: 'Traffic Police',
  reason: 'Forgot my password after leave', status: 'pending' as const,
  requested_at: new Date().toISOString(), reviewed_by: null, reviewed_at: null,
};

describe('PasswordResetRequestsSection', () => {
  beforeEach(() => {
    sessionStorage.setItem('netra_session_token', 'fake-jwt-token');
  });

  it('shows the requesting officer\'s identity and reason, with no password fields anywhere', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, json: async () => [PENDING_REQUEST] } as Response))
    );
    render(<PasswordResetRequestsSection />);

    expect(await screen.findByText('Demo Station Officer')).toBeInTheDocument();
    expect(screen.getByText('GJ-SO-001')).toBeInTheDocument();
    expect(screen.getByText('PI')).toBeInTheDocument();
    expect(screen.getByText('station_officer')).toBeInTheDocument();
    expect(screen.getByText('Traffic Police')).toBeInTheDocument();
    expect(screen.getByText(/forgot my password after leave/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/current password/i)).not.toBeInTheDocument();
  });

  it('approves a request by setting a new password and passing the request id', async () => {
    const resetSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => PENDING_REQUEST });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, opts?: RequestInit) => {
        if (url.includes('/reset-password')) return resetSpy(url, opts);
        return Promise.resolve({ ok: true, json: async () => [PENDING_REQUEST] } as Response);
      })
    );
    render(<PasswordResetRequestsSection />);
    await screen.findByText('Demo Station Officer');

    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: 'fresh-password-123' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'fresh-password-123' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm approval/i }));

    await waitFor(() => expect(resetSpy).toHaveBeenCalled());
    const [url, opts] = resetSpy.mock.calls[0];
    expect(url).toContain('/admin/officers/5/reset-password');
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({
      new_password: 'fresh-password-123',
      request_id: 1,
    });
  });

  it('rejects a request with an optional reason', async () => {
    const rejectSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...PENDING_REQUEST, status: 'rejected' }) });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, opts?: RequestInit) => {
        if (url.includes('/reject')) return rejectSpy(url, opts);
        return Promise.resolve({ ok: true, json: async () => [PENDING_REQUEST] } as Response);
      })
    );
    render(<PasswordResetRequestsSection />);
    await screen.findByText('Demo Station Officer');

    fireEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Could not verify identity' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm rejection/i }));

    await waitFor(() => expect(rejectSpy).toHaveBeenCalled());
    const [url, opts] = rejectSpy.mock.calls[0];
    expect(url).toContain('/admin/password-reset-requests/1/reject');
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ reason: 'Could not verify identity' });
  });

  it('shows an empty state when there are no pending requests', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => [] } as Response)));
    render(<PasswordResetRequestsSection />);
    expect(await screen.findByText(/no pending requests/i)).toBeInTheDocument();
  });
});
