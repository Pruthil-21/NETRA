import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useRouter } from 'next/navigation';
import RegisterPage from '@/app/register/page';
import { locationsService } from '@/services/locationsService';

vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));
vi.mock('@/services/locationsService', () => ({
  locationsService: { listDistricts: vi.fn() },
}));

describe('RegisterPage', () => {
  const push = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    push.mockClear();
    (useRouter as any).mockReturnValue({ push });
    (locationsService.listDistricts as any).mockResolvedValue([
      { id: 1, name: 'Ahmedabad', lgd_code: null },
      { id: 2, name: 'Anand', lgd_code: null },
    ]);
    sessionStorage.clear();
  });

  // A password strong enough to clear the client-side zxcvbn floor (see
  // lib/passwordStrength.ts) -- these tests are about the registration
  // flow, not the strength meter itself (covered separately).
  const STRONG_PASSWORD = 'Correct-Horse-Battery-Staple-9!';

  const fillRequiredFields = async () => {
    fireEvent.change(screen.getByLabelText('Badge Number'), { target: { value: 'GJ-REG-001' } });
    fireEvent.change(screen.getByLabelText('Full Name'), { target: { value: 'New Recruit' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'recruit@example.com' } });
    fireEvent.focus(screen.getByLabelText('Department / District'));
    fireEvent.click(await screen.findByText('Ahmedabad'));
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '9876543210' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: STRONG_PASSWORD } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: STRONG_PASSWORD } });
  };

  it('registering shows the OTP verification step instead of a pending-approval message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ pending_token: 'pending-abc' }) })
    );
    render(<RegisterPage />);

    await fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: /^register$/i }));

    expect(await screen.findByText('Verify Your Email')).toBeInTheDocument();
    expect(screen.getByText('recruit@example.com')).toBeInTheDocument();
  });

  it('entering the correct code activates the account and logs straight in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/auth/register/verify')) {
          return Promise.resolve({ ok: true, json: async () => ({ token: 'fake-jwt-token' }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ pending_token: 'pending-abc' }) });
      })
    );
    render(<RegisterPage />);

    await fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: /^register$/i }));
    await screen.findByText('Verify Your Email');

    fireEvent.change(screen.getByLabelText('Verification Code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify & activate account/i }));

    await waitFor(() => expect(sessionStorage.getItem('netra_session_token')).toBe('fake-jwt-token'));
    expect(push).toHaveBeenCalledWith('/');
  });

  it('shows an error and does not advance when registration fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ detail: 'Badge number already registered' }) })
    );
    render(<RegisterPage />);

    await fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: /^register$/i }));

    expect(await screen.findByText('Badge number already registered')).toBeInTheDocument();
    expect(screen.queryByText('Verify Your Email')).not.toBeInTheDocument();
  });

  it('offers Department/District as a searchable dropdown of real districts, not free text', async () => {
    render(<RegisterPage />);
    fireEvent.focus(screen.getByLabelText('Department / District'));
    expect(await screen.findByText('Ahmedabad')).toBeInTheDocument();
    expect(screen.getByText('Anand')).toBeInTheDocument();
  });

  it('rejects submission client-side when the password is too weak, without calling the API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ pending_token: 'pending-abc' }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<RegisterPage />);

    fireEvent.change(screen.getByLabelText('Badge Number'), { target: { value: 'GJ-REG-002' } });
    fireEvent.change(screen.getByLabelText('Full Name'), { target: { value: 'New Recruit' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'recruit@example.com' } });
    fireEvent.focus(screen.getByLabelText('Department / District'));
    fireEvent.click(await screen.findByText('Ahmedabad'));
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '9876543210' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: /^register$/i }));

    expect(await screen.findByText(/password is too weak/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/auth/register'), expect.anything());
  });
});
