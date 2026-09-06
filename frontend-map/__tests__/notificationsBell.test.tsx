import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { NotificationsBell } from '@/components/notifications/NotificationsBell';

const MOCK_NOTIFICATIONS = [
  { id: 1, officer_id: 5, type: 'role_granted', message: "You were granted the 'station_officer' role.", read: false, created_at: '2026-09-01T10:00:00Z' },
];

describe('NotificationsBell', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows an unread badge and the notification once opened', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => MOCK_NOTIFICATIONS }));
    render(<NotificationsBell />);

    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Notifications'));
    expect(screen.getByText(/granted the 'station_officer' role/i)).toBeInTheDocument();
  });

  it('marks a notification read when clicked', async () => {
    const markReadSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, opts?: RequestInit) => {
        if (url.includes('/read')) return markReadSpy(url, opts);
        return Promise.resolve({ ok: true, json: async () => MOCK_NOTIFICATIONS });
      })
    );
    render(<NotificationsBell />);
    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Notifications'));

    fireEvent.click(screen.getByText(/granted the 'station_officer' role/i));
    await waitFor(() => expect(markReadSpy).toHaveBeenCalled());
  });
});
