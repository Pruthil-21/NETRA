// frontend-map/__tests__/admin.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import AdminPage from '@/app/admin/page';

const AUDIT_LOG_PAGE = {
  logs: [
    { id: 1, badge_number: 'GJ-AUD-001', action: 'update', resource_type: 'camera', resource_id: 7, reason_code: null, timestamp: '2026-09-05T10:00:00Z' },
  ],
  next_cursor: null,
};

const MOCK_OFFICERS = [
  {
    id: 1, badge_number: 'GJ-SO-001', name: 'Demo Station Officer', rank: 'PI',
    active_posting: { id: 10, role: 'station_officer', scope_type: 'district', scope_value: 'Traffic Police' },
  },
];

describe('AdminPage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem('netra_session_token', 'fake-jwt-token');
    vi.restoreAllMocks();
  });

  it('lists officers with their current posting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/auth/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ permissions: ['manage_users_roles'] }) });
        }
        if (url.includes('/admin/officers')) {
          return Promise.resolve({ ok: true, json: async () => MOCK_OFFICERS });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      })
    );

    render(<AdminPage />);

    await waitFor(() => {
      expect(screen.getByText('Demo Station Officer')).toBeInTheDocument();
      expect(screen.getByText('GJ-SO-001')).toBeInTheDocument();
      expect(screen.getByText(/station_officer/i)).toBeInTheDocument();
    });
  });

  it('submits a posting reassignment', async () => {
    const postSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 11, officer_id: 1, role: 'control_room_operator', scope_type: 'district', scope_value: 'Traffic Police', is_active: true }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, opts?: RequestInit) => {
        if (url.includes('/auth/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ permissions: ['manage_users_roles'] }) });
        }
        if (url.includes('/admin/officers')) return Promise.resolve({ ok: true, json: async () => MOCK_OFFICERS });
        if (url.includes('/admin/postings') && opts?.method === 'POST') return postSpy(url, opts);
        return Promise.resolve({ ok: true, json: async () => [] });
      })
    );

    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('Demo Station Officer')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /reassign/i }));
    fireEvent.change(screen.getByLabelText(/new role/i), { target: { value: 'control_room_operator' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm reassignment/i }));

    await waitFor(() => expect(postSpy).toHaveBeenCalled());
  });

  it('lets a super admin reset an officer\'s password', async () => {
    const resetSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, opts?: RequestInit) => {
        if (url.includes('/auth/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ permissions: ['manage_users_roles', 'reset_officer_passwords'] }) });
        }
        if (url.includes('/reset-password')) return resetSpy(url, opts);
        if (url.includes('/admin/officers')) return Promise.resolve({ ok: true, json: async () => MOCK_OFFICERS });
        return Promise.resolve({ ok: true, json: async () => [] });
      })
    );

    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('Demo Station Officer')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));
    fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: 'new-secure-password-1' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'new-secure-password-1' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm reset/i }));

    await waitFor(() => expect(resetSpy).toHaveBeenCalled());
    const [, opts] = resetSpy.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ new_password: 'new-secure-password-1' });
    expect(await screen.findByText(/password reset/i)).toBeInTheDocument();
  });

  it('rejects a reset when the two password fields do not match, without calling the API', async () => {
    const resetSpy = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/auth/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ permissions: ['manage_users_roles', 'reset_officer_passwords'] }) });
        }
        if (url.includes('/reset-password')) return resetSpy();
        if (url.includes('/admin/officers')) return Promise.resolve({ ok: true, json: async () => MOCK_OFFICERS });
        return Promise.resolve({ ok: true, json: async () => [] });
      })
    );

    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('Demo Station Officer')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));
    fireEvent.change(screen.getByLabelText(/^new password$/i), { target: { value: 'password-one-here' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'password-two-here' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm reset/i }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(resetSpy).not.toHaveBeenCalled();
  });

  it('does not show the Reset Password button for a district command (manage_users_roles only)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/auth/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ permissions: ['manage_users_roles'] }) });
        }
        if (url.includes('/admin/officers')) return Promise.resolve({ ok: true, json: async () => MOCK_OFFICERS });
        return Promise.resolve({ ok: true, json: async () => [] });
      })
    );

    render(<AdminPage />);
    await waitFor(() => expect(screen.getByText('Demo Station Officer')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /reset password/i })).not.toBeInTheDocument();
  });

  it('shows only the Audit Log section for an Auditor, never the officers list or its fetch', async () => {
    const officersFetch = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/auth/me')) {
          return Promise.resolve({ ok: true, json: async () => ({ permissions: ['view_audit_logs'] }) });
        }
        if (url.includes('/admin/officers')) {
          officersFetch();
          return Promise.resolve({ ok: true, json: async () => MOCK_OFFICERS });
        }
        if (url.includes('/audit-logs')) {
          return Promise.resolve({ ok: true, json: async () => AUDIT_LOG_PAGE });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      })
    );

    render(<AdminPage />);

    expect(await screen.findByText('Audit Log')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('GJ-AUD-001')).toBeInTheDocument());
    expect(screen.queryByText('Officers & Postings')).not.toBeInTheDocument();
    expect(officersFetch).not.toHaveBeenCalled();
  });
});
