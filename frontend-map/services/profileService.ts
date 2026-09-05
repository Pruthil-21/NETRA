// frontend-map/services/profileService.ts
import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await fetch(`${REGISTRY_API_URL}/auth/change-password`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'Current password is incorrect' : `Failed to change password: HTTP ${res.status}`);
  }
}

export async function updateProfilePhoto(photoUrl: string | null): Promise<void> {
  const res = await fetch(`${REGISTRY_API_URL}/auth/me/photo`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ photo_url: photoUrl }),
  });
  if (!res.ok) throw new Error(`Failed to update profile photo: HTTP ${res.status}`);
}
