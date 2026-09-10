import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ProfilePage from '@/app/profile/page';
import { usePermissions } from '@/hooks/usePermissions';
import { changePassword, updateProfilePhoto } from '@/services/profileService';

vi.mock('@/hooks/usePermissions');
vi.mock('@/services/profileService');

const BASE_PERMISSIONS = {
  badgeNumber: 'GJ-SO-001',
  name: 'Test Officer',
  role: 'station_officer',
  rank: 'PI',
  photoUrl: null,
  lastLogin: '2026-01-01T10:00:00Z',
  scopeValue: 'Traffic Police',
  permissions: [],
  loading: false,
  has: () => false,
  refetch: vi.fn(),
};

describe('ProfilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (usePermissions as any).mockReturnValue(BASE_PERMISSIONS);
  });

  it('shows a loading state while permissions are loading', () => {
    (usePermissions as any).mockReturnValue({ ...BASE_PERMISSIONS, loading: true });
    render(<ProfilePage />);
    expect(screen.getByText(/Loading profile/i)).toBeInTheDocument();
  });

  it('renders read-only officer details', () => {
    render(<ProfilePage />);
    expect(screen.getByText('Test Officer')).toBeInTheDocument();
    expect(screen.getByText('GJ-SO-001')).toBeInTheDocument();
    expect(screen.getByText('Station Officer')).toBeInTheDocument();
    expect(screen.getByText('PI')).toBeInTheDocument();
    expect(screen.getByText('Traffic Police')).toBeInTheDocument();
  });

  it('shows a fallback avatar and lets the officer add a photo URL', async () => {
    (updateProfilePhoto as any).mockResolvedValue(undefined);
    render(<ProfilePage />);

    fireEvent.click(screen.getByText('Add a photo'));
    fireEvent.change(screen.getByLabelText('Profile photo URL'), {
      target: { value: 'https://example.com/avatar.jpg' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(updateProfilePhoto).toHaveBeenCalledWith('https://example.com/avatar.jpg'));
    expect(BASE_PERMISSIONS.refetch).toHaveBeenCalled();
  });

  it('submits a password reset request with the typed reason, and shows a confirmation', async () => {
    const requestSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 1, status: 'pending' }) });
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, opts?: RequestInit) => requestSpy(_url, opts))
    );
    sessionStorage.setItem('netra_session_token', 'fake-jwt-token');

    render(<ProfilePage />);
    fireEvent.change(screen.getByLabelText(/reason \(optional\)/i), { target: { value: 'Forgot after leave' } });
    fireEvent.click(screen.getByRole('button', { name: /request password reset/i }));

    await waitFor(() => expect(requestSpy).toHaveBeenCalled());
    const [url, opts] = requestSpy.mock.calls[0];
    expect(url).toContain('/auth/password-reset-requests');
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ reason: 'Forgot after leave' });
    expect(await screen.findByText(/request submitted/i)).toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it('rejects a change-password submission when new password is too short', async () => {
    render(<ProfilePage />);
    fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: 'oldpass123' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));

    expect(await screen.findByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('rejects a change-password submission when confirmation does not match', async () => {
    render(<ProfilePage />);
    fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: 'oldpass123' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'newpassword1' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'newpassword2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('submits a valid change-password form and shows a success message', async () => {
    (changePassword as any).mockResolvedValue(undefined);
    render(<ProfilePage />);
    fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: 'oldpass123' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'newpassword1' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'newpassword1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));

    await waitFor(() => expect(changePassword).toHaveBeenCalledWith('oldpass123', 'newpassword1'));
    expect(await screen.findByText(/Password updated/i)).toBeInTheDocument();
  });

  it('shows the backend error message when the current password is wrong', async () => {
    (changePassword as any).mockRejectedValue(new Error('Current password is incorrect'));
    render(<ProfilePage />);
    fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: 'wrongpass' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'newpassword1' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'newpassword1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));

    expect(await screen.findByText('Current password is incorrect')).toBeInTheDocument();
  });
});
