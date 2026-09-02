// frontend-map/__tests__/session.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { login, logout, getToken, isLoggedIn } from '@/lib/session';

describe('session', () => {
  beforeEach(() => {
    sessionStorage.clear();
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
});
