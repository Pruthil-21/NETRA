// frontend-map/__tests__/usePermissions.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePermissions } from '@/hooks/usePermissions';

describe('usePermissions', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('fetches and exposes the logged-in officer\'s permissions', async () => {
    sessionStorage.setItem('netra_session_token', 'fake-jwt-token');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          badge_number: 'GJ-SO-001', name: 'Test Officer', role: 'station_officer',
          scope_type: 'district', scope_value: 'Traffic Police',
          permissions: ['view_live_feeds', 'edit_watchlist'],
        }),
      })
    );

    const { result } = renderHook(() => usePermissions());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.role).toBe('station_officer');
    expect(result.current.has('edit_watchlist')).toBe(true);
    expect(result.current.has('manage_cameras')).toBe(false);
  });

  it('returns no permissions when not logged in', async () => {
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.permissions).toEqual([]);
    expect(result.current.has('view_live_feeds')).toBe(false);
  });
});
