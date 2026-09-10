// frontend-map/services/profileService.ts
import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';

export async function updateProfilePhoto(photoUrl: string | null): Promise<void> {
  const res = await fetch(`${REGISTRY_API_URL}/auth/me/photo`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ photo_url: photoUrl }),
  });
  if (!res.ok) throw new Error(`Failed to update profile photo: HTTP ${res.status}`);
}

export interface EmailUpdateResult {
  /** Always true -- 2FA is mandatory, so this only ever changes the
   * address. Nothing is written yet: call verifyMyEmail with
   * `pendingToken` and the code just emailed to finish. */
  verificationRequired: boolean;
  pendingToken?: string;
}

/** Setting a new email is a two-step process -- this only sends a
 * verification code to it; nothing is written to the officer's record
 * until verifyMyEmail succeeds with that code (turning 2FA onto an
 * inbox you don't actually control would be a real security hole).
 * Requires the current password, the same confirmation bar as every
 * other security-relevant profile edit. */
export async function updateMyEmail(email: string, currentPassword: string): Promise<EmailUpdateResult> {
  const res = await fetch(`${REGISTRY_API_URL}/auth/me/email`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ email, current_password: currentPassword }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      res.status === 401 ? 'Current password is incorrect' : body?.detail || `Failed to update email: HTTP ${res.status}`
    );
  }
  const body = await res.json();
  return body.verification_required
    ? { verificationRequired: true, pendingToken: body.pending_token }
    : { verificationRequired: false };
}

/** Completes updateMyEmail's verification step -- the emailed code, checked
 * against `pendingToken`, is what actually writes the new address to the
 * officer's record and turns 2FA on for it. */
export async function verifyMyEmail(pendingToken: string, code: string): Promise<void> {
  const res = await fetch(`${REGISTRY_API_URL}/auth/me/email/verify`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ pending_token: pendingToken, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || (res.status === 401 ? 'Incorrect or expired code' : `Verification failed: HTTP ${res.status}`));
  }
}
