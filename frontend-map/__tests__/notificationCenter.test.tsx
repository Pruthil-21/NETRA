import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NotificationCenter } from '@/components/shell/NotificationCenter';

const CAMERA = {
  id: 7, name: 'Ring Road Cam', dept: 'Traffic Police', lat: 23.03, long: 72.58,
  camera_type: 'Bullet', ownership: 'Traffic Police', connectivity_status: 'online',
  storage_type: 'Cloud', retention_days: 30, health_status: 'operational', rtsp_url: '',
};

const ALERT = {
  id: 1, camera_id: 7, plate_number: 'GJ01AB1234', watchlist_id: 3, detection_id: null,
  matched_at: new Date().toISOString(), status: 'NEW' as const,
  nearest_station: { name: 'Ring Road Police Station', distance_meters: 850 },
};

const NOTIFICATION = {
  id: 1, officer_id: 5, type: 'role_granted', message: "You were granted the 'station_officer' role.",
  read: false, created_at: '2026-09-01T10:00:00Z',
};

vi.mock('@/context/CameraRegistryContext', () => ({
  useCameraRegistry: () => ({ cameras: [CAMERA] }),
}));

vi.mock('@/lib/geolocation', () => ({
  useGeolocation: () => ({ status: 'ready', position: { lat: 23.03, long: 72.58 } }),
}));

vi.mock('@/services/alertsService', () => ({
  alertsService: { list: vi.fn() },
}));

vi.mock('@/services/adminService', () => ({
  adminService: {
    listNotifications: vi.fn(),
    markNotificationRead: vi.fn().mockResolvedValue(undefined),
    markAllNotificationsRead: vi.fn().mockResolvedValue(undefined),
    clearAllNotifications: vi.fn().mockResolvedValue(undefined),
  },
}));

import { alertsService } from '@/services/alertsService';
import { adminService } from '@/services/adminService';

describe('NotificationCenter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (alertsService.list as any).mockResolvedValue([ALERT]);
    (adminService.listNotifications as any).mockResolvedValue([NOTIFICATION]);
  });

  it('is a single bell, badged with alerts + notifications combined', async () => {
    render(<NotificationCenter />);
    const bell = await screen.findByRole('button', { name: /alerts and notifications/i });
    await waitFor(() => expect(bell).toHaveTextContent('2'));
    // Only one bell button in the whole header widget -- not two side by side.
    expect(screen.getAllByRole('button', { name: /alerts and notifications/i })).toHaveLength(1);
  });

  it('opens on the Alerts tab by default, showing the nearby alert', async () => {
    render(<NotificationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /alerts and notifications/i }));

    expect(await screen.findByText('GJ01AB1234')).toBeInTheDocument();
    expect(screen.getByText(/Ring Road Police Station/)).toBeInTheDocument();
    expect(screen.getByText(/850m/)).toBeInTheDocument();
  });

  it('switching to the Notifications tab shows account/RBAC notifications instead', async () => {
    render(<NotificationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /alerts and notifications/i }));
    await screen.findByText('GJ01AB1234');

    fireEvent.click(screen.getByRole('tab', { name: /notifications/i }));
    expect(await screen.findByText(/granted the 'station_officer' role/i)).toBeInTheDocument();
    expect(screen.queryByText('GJ01AB1234')).not.toBeInTheDocument();
  });

  it('marks a notification read when clicked', async () => {
    render(<NotificationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /alerts and notifications/i }));
    fireEvent.click(screen.getByRole('tab', { name: /notifications/i }));

    fireEvent.click(await screen.findByText(/granted the 'station_officer' role/i));
    await waitFor(() => expect(adminService.markNotificationRead).toHaveBeenCalledWith(1));
  });

  it('opening the panel marks unread notifications read and drops the badge count', async () => {
    render(<NotificationCenter />);
    const bell = await screen.findByRole('button', { name: /alerts and notifications/i });
    await waitFor(() => expect(bell).toHaveTextContent('2'));

    fireEvent.click(bell);
    await waitFor(() => expect(adminService.markAllNotificationsRead).toHaveBeenCalled());
    // 1 nearby alert remains; the 1 unread notification no longer counts.
    await waitFor(() => expect(bell).toHaveTextContent('1'));
  });

  it('does not call mark-all-read when there is nothing unread to clear', async () => {
    (adminService.listNotifications as any).mockResolvedValue([{ ...NOTIFICATION, read: true }]);
    render(<NotificationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /alerts and notifications/i }));

    await waitFor(() => expect(screen.getByRole('tab', { name: /notifications/i })).toBeInTheDocument());
    expect(adminService.markAllNotificationsRead).not.toHaveBeenCalled();
  });

  it('Clear all removes every notification and calls the clear-all endpoint', async () => {
    render(<NotificationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /alerts and notifications/i }));
    fireEvent.click(screen.getByRole('tab', { name: /notifications/i }));

    fireEvent.click(await screen.findByRole('button', { name: /clear all/i }));
    await waitFor(() => expect(adminService.clearAllNotifications).toHaveBeenCalled());
    expect(screen.queryByText(/granted the 'station_officer' role/i)).not.toBeInTheDocument();
    expect(screen.getByText(/nothing yet/i)).toBeInTheDocument();
  });
});
