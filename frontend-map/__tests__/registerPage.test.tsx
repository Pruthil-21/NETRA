import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useRouter } from 'next/navigation';
import RegisterPage from '@/app/register/page';

vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));

describe('RegisterPage', () => {
  const push = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    push.mockClear();
    (useRouter as any).mockReturnValue({ push });
    sessionStorage.clear();
  });

  const fillRequiredFields = () => {
    fireEvent.change(screen.getByLabelText('Badge Number'), { target: { value: 'GJ-REG-001' } });
    fireEvent.change(screen.getByLabelText('Full Name'), { target: { value: 'New Recruit' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'recruit@example.com' } });
    fireEvent.change(screen.getByLabelText('Department / District'), { target: { value: 'Ahmedabad' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'recruit-pass-123' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'recruit-pass-123' } });
  };

  it('registering shows the OTP verification step instead of a pending-approval message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ pending_token: 'pending-abc' }) })
    );
    render(<RegisterPage />);

    fillRequiredFields();
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

    fillRequiredFields();
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

    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: /^register$/i }));

    expect(await screen.findByText('Badge number already registered')).toBeInTheDocument();
    expect(screen.queryByText('Verify Your Email')).not.toBeInTheDocument();
  });
});
