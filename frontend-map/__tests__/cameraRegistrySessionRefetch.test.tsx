// frontend-map/__tests__/cameraRegistrySessionRefetch.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { CameraRegistryProvider, useCameraRegistry } from '@/context/CameraRegistryContext';
import { login } from '@/lib/session';

// CameraRegistryProvider mounts once at the app root, which can happen
// before anyone has logged in (landing on /login unauthenticated) -- its
// one-time fetch-on-mount 401s with no token and never retries on its own,
// since login() navigates client-side afterward rather than reloading the
// page. Without a real login re-triggering that fetch, every camera
// tree/area shows zero cameras until a hard refresh. This is what
// session.ts's SESSION_CHANGED_EVENT fixes.

function Consumer() {
  const { cameras } = useCameraRegistry();
  return <div data-testid="camera-count">{cameras.length}</div>;
}

describe('CameraRegistryContext refetches when login() succeeds', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('fetches the registry again after a real login, without a remount', async () => {
    const cameraFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, opts?: RequestInit) => {
        if (url.includes('/auth/login')) return Promise.resolve({ ok: true, json: async () => ({ token: 'fake-jwt-token' }) });
        if (url.includes('/cameras')) return cameraFetch(url, opts);
        return Promise.resolve({ ok: true, json: async () => [] });
      })
    );

    render(
      <CameraRegistryProvider>
        <Consumer />
      </CameraRegistryProvider>
    );

    // The provider's own unconditional mount-time fetch (still logged out).
    await waitFor(() => expect(cameraFetch).toHaveBeenCalledTimes(1));

    await login('GJ-SA-001', 'demo-pass-super-admin');

    // A real login must trigger a second fetch, without remounting the provider.
    await waitFor(() => expect(cameraFetch).toHaveBeenCalledTimes(2));
  });
});
