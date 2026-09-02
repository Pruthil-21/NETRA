// frontend-map/hooks/usePermissions.ts
'use client';

import { useEffect, useState } from 'react';
import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';
import { isLoggedIn } from '@/lib/session';

interface MeResponse {
  badge_number: string;
  name: string;
  role: string;
  scope_type: string;
  scope_value: string | null;
  permissions: string[];
}

interface UsePermissionsResult {
  role: string | null;
  scopeValue: string | null;
  permissions: string[];
  loading: boolean;
  has: (permission: string) => boolean;
}

/** Drives permission-aware UI gating (hide, don't just 403, actions an
 * officer's role can't perform) -- fetches GET /auth/me once per mount,
 * backed by whatever session token is currently stored. */
export function usePermissions(): UsePermissionsResult {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isLoggedIn()) {
      setLoading(false);
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
  }, []);

  const permissions = me?.permissions ?? [];
  return {
    role: me?.role ?? null,
    scopeValue: me?.scope_value ?? null,
    permissions,
    loading,
    has: (permission: string) => permissions.includes(permission),
  };
}
