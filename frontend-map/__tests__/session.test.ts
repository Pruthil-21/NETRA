// frontend-map/__tests__/session.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  login,
  logout,
  getToken,
  isLoggedIn,
  verifyLoginOtp,
  requestPasswordResetOtp,
  resetPasswordWithOtp,
} from '@/lib/session';

describe('session', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('stores the token on successful login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: 'fake-jwt-token' }) })
    );

    await login('GJ-SA-001', 'demo-pass-super-admin');

    expect(getToken()).toBe('fake-jwt-token');
    expect(isLoggedIn()).toBe(true);
  });

  it('throws and does not store a token on a failed login', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    await expect(login('GJ-SA-001', 'wrong-password')).rejects.toThrow();
    expect(getToken()).toBeNull();
    expect(isLoggedIn()).toBe(false);
  });

  it('clears the token on logout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: 'fake-jwt-token' }) })
    );
    await login('GJ-SA-001', 'demo-pass-super-admin');

    logout();

    expect(getToken()).toBeNull();
    expect(isLoggedIn()).toBe(false);
  });

  it('returns otpRequired without storing a token when 2FA is on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ token: null, otp_required: true, pending_token: 'pending-abc' }),
      })
    );

    const result = await login('GJ-SA-001', 'demo-pass-super-admin');

    expect(result).toEqual({ otpRequired: true, pendingToken: 'pending-abc' });
    expect(getToken()).toBeNull();
  });

  it('sends a stored device_token on future logins', async () => {
    localStorage.setItem('netra_device_token', 'remembered-device-token');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: 'fake-jwt-token' }) });
    vi.stubGlobal('fetch', fetchMock);

    await login('GJ-SA-001', 'demo-pass-super-admin');

    const [, options] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(options.body as string);
    expect(sentBody.device_token).toBe('remembered-device-token');
  });

  it('verifyLoginOtp stores the token and, when returned, the device token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ token: 'fake-jwt-token', device_token: 'new-device-token' }),
      })
    );

    await verifyLoginOtp('pending-abc', '123456', true);

    expect(getToken()).toBe('fake-jwt-token');
    expect(localStorage.getItem('netra_device_token')).toBe('new-device-token');
  });

  it('verifyLoginOtp throws and stores nothing on a wrong code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    await expect(verifyLoginOtp('pending-abc', '000000', false)).rejects.toThrow();
    expect(getToken()).toBeNull();
  });

  it('requestPasswordResetOtp resolves even when the fetch reports failure -- never surfaces enumeration info', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(requestPasswordResetOtp('GJ-NOPE-999')).resolves.toBeUndefined();
  });

  it('resetPasswordWithOtp throws on an incorrect code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(resetPasswordWithOtp('GJ-SA-001', '000000', 'new-password-123')).rejects.toThrow();
  });

  it('resetPasswordWithOtp resolves on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    await expect(resetPasswordWithOtp('GJ-SA-001', '123456', 'new-password-123')).resolves.toBeUndefined();
  });
});
