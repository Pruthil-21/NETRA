// frontend-map/lib/apiAuth.ts
import { getToken } from './session';

export function authHeaders(): HeadersInit {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function unauthorizedError(label: string): Error {
  return new Error(`Failed to ${label}: 401 Unauthorized (not logged in)`);
}

export function isJwtConfigured(): boolean {
  return getToken() !== null;
}
