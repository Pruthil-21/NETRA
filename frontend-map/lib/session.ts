// frontend-map/lib/session.ts
import { REGISTRY_API_URL } from '@/config/streams';

const TOKEN_KEY = 'netra_session_token';

// CameraRegistryProvider (the app root, mounted once in layout.tsx) fetches
// the camera registry exactly once on mount -- and that mount happens the
// very first time the app loads, which is often *before* anyone has logged
// in (landing on /login unauthenticated). That one fetch 401s with no
// token, and login() navigates client-side afterward (no full page
// reload), so the provider never gets a second chance to fetch with the
// token now in place -- every camera's areas render with zero cameras
// under them until a hard refresh remounts the provider fresh, this time
// with the token already present. This event is that second chance: it
// fires the instant a real login succeeds, and CameraRegistryContext
// listens for it to refetch immediately, without touching the provider's
// own always-fetch-on-mount behavior (relied on by every existing test
// that renders it with no token at all).
export const SESSION_CHANGED_EVENT = 'netra:session-changed';

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
  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
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
