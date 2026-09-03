// frontend-map/lib/session.ts
import { REGISTRY_API_URL } from '@/config/streams';

const TOKEN_KEY = 'netra_session_token';

/** Real officer login (POST /auth/login) -- replaces the old
 * NEXT_PUBLIC_DEMO_OFFICER_JWT env-var stand-in with a per-session token
 * tied to whoever actually authenticated. sessionStorage (not localStorage)
 * so a shared control-room terminal doesn't keep a stale login across
 * browser restarts. */
export async function login(badgeNumber: string, password: string): Promise<void> {
  const res = await fetch(`${REGISTRY_API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ badge_number: badgeNumber, password }),
  });
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'Invalid badge number or password' : `Login failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  sessionStorage.setItem(TOKEN_KEY, body.token);
}

export function logout(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

export function isLoggedIn(): boolean {
  return getToken() !== null;
}
