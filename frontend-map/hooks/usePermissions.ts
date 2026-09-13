// frontend-map/hooks/usePermissions.ts
'use client';

import { useEffect, useState } from 'react';
import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';
import { isLoggedIn } from '@/lib/session';

interface MeResponse {
  badge_number: string;
  name: string;
  role: string | null;
  rank: string | null;
  photo_url: string | null;
  email: string | null;
  contact_info: string | null;
  last_login: string | null;
  status: string;
  scope_type: string | null;
  scope_value: string | null;
  permissions: string[];
}

interface UsePermissionsResult {
  badgeNumber: string | null;
  name: string | null;
  role: string | null;
  rank: string | null;
  photoUrl: string | null;
  /** Non-null is what "login 2FA and self-service password reset are on for
   * this officer" means -- see backend-registry's schema.sql comment on
   * officers.email. Set via PUT /auth/me/email (profile page). */
  email: string | null;
  contactInfo: string | null;
  lastLogin: string | null;
  status: string | null;
  scopeType: string | null;
  scopeValue: string | null;
  permissions: string[];
  loading: boolean;
  has: (permission: string) => boolean;
  /** Re-fetches GET /auth/me -- for callers that just changed profile data
   * (e.g. the profile page after updating the photo) and want the shared
   * hook state to reflect it immediately rather than waiting for a remount. */
  refetch: () => void;
}

/** Drives permission-aware UI gating (hide, don't just 403, actions an
 * officer's role can't perform) -- fetches GET /auth/me once per mount,
 * backed by whatever session token is currently stored. Also the shared
 * source of the logged-in officer's own profile fields (name, rank, photo,
 * last login) so the profile page and the shell's last-login indicator both
 * read from the same fetch instead of each hitting /auth/me separately. */
export function usePermissions(): UsePermissionsResult {
  const [me, setMe] = useState<MeResponse | null>(null);
  // Lazy initializer: when there's no session at all, there's nothing to
  // fetch, so `loading` should never be true in the first place -- setting
  // it to false synchronously inside the effect below instead would trigger
  // an extra render (react-hooks/set-state-in-effect).
  const [loading, setLoading] = useState(() => isLoggedIn());
  const [refreshIndex, setRefreshIndex] = useState(0);

  useEffect(() => {
    if (!isLoggedIn()) {
      return;
    }
    let cancelled = false;
    fetch(`${REGISTRY_API_URL}/auth/me`, { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: MeResponse | null) => {
        if (!cancelled) setMe(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshIndex]);

  const permissions = me?.permissions ?? [];
  return {
    badgeNumber: me?.badge_number ?? null,
    name: me?.name ?? null,
    role: me?.role ?? null,
    rank: me?.rank ?? null,
    photoUrl: me?.photo_url ?? null,
    email: me?.email ?? null,
    contactInfo: me?.contact_info ?? null,
    lastLogin: me?.last_login ?? null,
    status: me?.status ?? null,
    scopeType: me?.scope_type ?? null,
    scopeValue: me?.scope_value ?? null,
    permissions,
    loading,
    has: (permission: string) => permissions.includes(permission),
    refetch: () => setRefreshIndex((n) => n + 1),
  };
}
