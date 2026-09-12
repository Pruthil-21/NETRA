import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ProfilePage from '@/app/profile/page';
import { usePermissions } from '@/hooks/usePermissions';
import { updateProfilePhoto, updateMyEmail, verifyMyEmail } from '@/services/profileService';
import { fileToAvatarDataUri, ImageUploadError } from '@/lib/imageUpload';
import { isPushSupported, isSubscribed, subscribe, unsubscribe } from '@/services/pushSubscriptionService';

vi.mock('@/hooks/usePermissions');
vi.mock('@/services/profileService');
vi.mock('@/lib/imageUpload', async () => {
  const actual = await vi.importActual<typeof import('@/lib/imageUpload')>('@/lib/imageUpload');
  return { ...actual, fileToAvatarDataUri: vi.fn() };
});
vi.mock('@/services/pushSubscriptionService');

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
    (isPushSupported as any).mockReturnValue(true);
    (isSubscribed as any).mockResolvedValue(false);
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

  it('defaults to the file-upload picker, styled as an "Add a file" button', () => {
    render(<ProfilePage />);

    fireEvent.click(screen.getByText('Add a photo'));
    expect(screen.getByText('Add a file')).toBeInTheDocument();
    expect(screen.queryByLabelText('Profile photo URL')).not.toBeInTheDocument();
  });

  it('lets the officer switch to pasting a photo URL instead', async () => {
    (updateProfilePhoto as any).mockResolvedValue(undefined);
    render(<ProfilePage />);

    fireEvent.click(screen.getByText('Add a photo'));
    fireEvent.click(screen.getByText('Or paste a URL instead'));
    fireEvent.change(screen.getByLabelText('Profile photo URL'), {
      target: { value: 'https://example.com/avatar.jpg' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(updateProfilePhoto).toHaveBeenCalledWith('https://example.com/avatar.jpg'));
    expect(BASE_PERMISSIONS.refetch).toHaveBeenCalled();
  });

  it('resizes a picked image file client-side and saves it as the photo', async () => {
    (updateProfilePhoto as any).mockResolvedValue(undefined);
    (fileToAvatarDataUri as any).mockResolvedValue('data:image/jpeg;base64,resized');
    render(<ProfilePage />);

    fireEvent.click(screen.getByText('Add a photo'));
    const file = new File(['fake-bytes'], 'avatar.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Upload profile photo'), { target: { files: [file] } });

    expect(await screen.findByText('avatar.png')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(updateProfilePhoto).toHaveBeenCalledWith('data:image/jpeg;base64,resized'));
    expect(BASE_PERMISSIONS.refetch).toHaveBeenCalled();
  });

  it('shows an error and does not select the file when it is not an image', async () => {
    (fileToAvatarDataUri as any).mockRejectedValue(new ImageUploadError('Only image files are allowed.'));
    render(<ProfilePage />);

    fireEvent.click(screen.getByText('Add a photo'));
    const file = new File(['not-an-image'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Upload profile photo'), { target: { files: [file] } });

    expect(await screen.findByText('Only image files are allowed.')).toBeInTheDocument();
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();
  });

  it('lets the officer remove a picked file before saving', async () => {
    (fileToAvatarDataUri as any).mockResolvedValue('data:image/jpeg;base64,resized');
    render(<ProfilePage />);

    fireEvent.click(screen.getByText('Add a photo'));
    const file = new File(['fake-bytes'], 'avatar.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Upload profile photo'), { target: { files: [file] } });
    expect(await screen.findByText('avatar.png')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Remove selected file'));
    expect(screen.queryByText('avatar.png')).not.toBeInTheDocument();
    expect(screen.getByText('Add a file')).toBeInTheDocument();
  });

  it('setting a 2FA email requires entering the verification code before it takes effect', async () => {
    (updateMyEmail as any).mockResolvedValue({ verificationRequired: true, pendingToken: 'pending-abc' });
    (verifyMyEmail as any).mockResolvedValue(undefined);
    render(<ProfilePage />);

    fireEvent.click(screen.getByText('Add an email'));
    fireEvent.change(screen.getByLabelText('Email', { selector: '#two-factor-email' }), {
      target: { value: 'officer@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Current Password', { selector: '#two-factor-current-password' }), {
      target: { value: 'currentpass1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send verification code/i }));

    await waitFor(() => expect(updateMyEmail).toHaveBeenCalledWith('officer@example.com', 'currentpass1'));
    expect(await screen.findByText(/we emailed a 6-digit code/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Verification Code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify & save/i }));

    await waitFor(() => expect(verifyMyEmail).toHaveBeenCalledWith('pending-abc', '123456'));
    expect(BASE_PERMISSIONS.refetch).toHaveBeenCalled();
  });

  it('shows the push notifications section with a Turn On button when not yet subscribed', async () => {
    render(<ProfilePage />);
    expect(await screen.findByText('Push Notifications')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /turn on/i })).toBeInTheDocument();
  });

  it('shows a Turn Off button when already subscribed', async () => {
    (isSubscribed as any).mockResolvedValue(true);
    render(<ProfilePage />);
    expect(await screen.findByRole('button', { name: /turn off/i })).toBeInTheDocument();
  });

  it('subscribes when turned on', async () => {
    (subscribe as any).mockResolvedValue(undefined);
    render(<ProfilePage />);

    fireEvent.click(await screen.findByRole('button', { name: /turn on/i }));
    await waitFor(() => expect(subscribe).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: /turn off/i })).toBeInTheDocument();
  });

  it('unsubscribes when turned off, and surfaces a failure without flipping state', async () => {
    (isSubscribed as any).mockResolvedValue(true);
    (unsubscribe as any).mockRejectedValue(new Error('network blip'));
    render(<ProfilePage />);

    fireEvent.click(await screen.findByRole('button', { name: /turn off/i }));
    await waitFor(() => expect(unsubscribe).toHaveBeenCalled());
    expect(await screen.findByText('network blip')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /turn off/i })).toBeInTheDocument();
  });

  it('shows a not-supported message instead of a toggle when push is unavailable', async () => {
    (isPushSupported as any).mockReturnValue(false);
    render(<ProfilePage />);
    expect(await screen.findByText(/not supported in this browser/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /turn on/i })).not.toBeInTheDocument();
  });
});
