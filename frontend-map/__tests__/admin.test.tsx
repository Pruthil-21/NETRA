// frontend-map/__tests__/admin.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import AdminPage from '@/app/admin/page';

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
});
