// frontend-map/lib/session.ts
import { REGISTRY_API_URL } from '@/config/streams';

const TOKEN_KEY = 'netra_session_token';
// localStorage, not sessionStorage: a "remembered" device must survive
// closing the browser/tab (that's the whole point of remembering it) --
// TOKEN_KEY deliberately does NOT live here, so a shared control-room
// terminal still loses the actual logged-in session on browser restart,
// same as before this feature existed. Only the "skip the OTP step"
// device-trust decision persists.
const DEVICE_TOKEN_KEY = 'netra_device_token';

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

function applySessionToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
}

function getDeviceToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(DEVICE_TOKEN_KEY);
}

export interface LoginResult {
  /** True when the officer has email 2FA on and this device isn't a
   * remembered one -- no session token yet; the caller must show the OTP
   * step and call verifyLoginOtp with `pendingToken`. False means login is
   * already complete (either 2FA is off for this officer, or a valid
   * device_token from a previous "remember this device" was presented). */
  otpRequired: boolean;
  pendingToken?: string;
}

/** Real officer login (POST /auth/login) -- replaces the old
 * NEXT_PUBLIC_DEMO_OFFICER_JWT env-var stand-in with a per-session token
 * tied to whoever actually authenticated. */
export async function login(badgeNumber: string, password: string): Promise<LoginResult> {
  const deviceToken = getDeviceToken();
  const res = await fetch(`${REGISTRY_API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      badge_number: badgeNumber,
      password,
      ...(deviceToken ? { device_token: deviceToken } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'Invalid badge number or password' : `Login failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body.otp_required) {
    return { otpRequired: true, pendingToken: body.pending_token };
  }
  applySessionToken(body.token);
  return { otpRequired: false };
}

/** Completes a login that returned otpRequired -- verifies the emailed code
 * against `pendingToken` and, on success, applies the real session token
 * exactly as login() would have. rememberDevice stores a device token in
 * localStorage so a future login() from this browser skips the OTP step. */
export async function verifyLoginOtp(
  pendingToken: string,
  code: string,
  rememberDevice: boolean
): Promise<void> {
  const res = await fetch(`${REGISTRY_API_URL}/auth/verify-login-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pending_token: pendingToken, code, remember_device: rememberDevice }),
  });
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'Incorrect or expired code' : `Verification failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body.device_token) {
    localStorage.setItem(DEVICE_TOKEN_KEY, body.device_token);
  }
  applySessionToken(body.token);
}

/** Always resolves regardless of whether the badge number/email is real --
 * the backend intentionally returns the same generic response either way
 * (see backend-registry's request_password_reset_otp) so this can't be used
 * to enumerate valid badge numbers. */
export async function requestPasswordResetOtp(badgeNumber: string): Promise<void> {
  await fetch(`${REGISTRY_API_URL}/auth/request-password-reset-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ badge_number: badgeNumber }),
  });
}

export async function resetPasswordWithOtp(badgeNumber: string, code: string, newPassword: string): Promise<void> {
  const res = await fetch(`${REGISTRY_API_URL}/auth/reset-password-with-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ badge_number: badgeNumber, code, new_password: newPassword }),
  });
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'Incorrect or expired code' : `Reset failed: HTTP ${res.status}`);
  }
}

export interface RegisterInput {
  badgeNumber: string;
  name: string;
  rank?: string;
  /** Becomes the officer's initial posting's district scope the moment
   * their email verifies -- there's no admin left in the loop to supply
   * one, so the backend requires it. */
  department: string;
  /** The account's email from day one -- verifying it (see
   * verifyRegistrationOtp) is what activates the account instead of
   * waiting on admin approval, and it doubles as this officer's 2FA email
   * with no separate setup step needed. */
  email: string;
  contactInfo?: string;
  password: string;
}

/** Public self-registration (POST /auth/register) -- creates the officer
 * row but does NOT activate it; the returned pendingToken must be verified
 * with verifyRegistrationOtp (the code just emailed) to finish. */
export async function registerOfficer(input: RegisterInput): Promise<{ pendingToken: string }> {
  const res = await fetch(`${REGISTRY_API_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      badge_number: input.badgeNumber,
      name: input.name,
      rank: input.rank || null,
      department: input.department,
      email: input.email,
      contact_info: input.contactInfo || null,
      password: input.password,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Registration failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  return { pendingToken: body.pending_token };
}

/** Completes registerOfficer's verification step -- on success the account
 * is active with a baseline posting, and this applies the real session
 * token immediately (no separate login step needed). */
export async function verifyRegistrationOtp(pendingToken: string, code: string): Promise<void> {
  const res = await fetch(`${REGISTRY_API_URL}/auth/register/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pending_token: pendingToken, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      body?.detail || (res.status === 401 ? 'Incorrect or expired code' : `Verification failed: HTTP ${res.status}`)
    );
  }
  const body = await res.json();
  applySessionToken(body.token);
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
