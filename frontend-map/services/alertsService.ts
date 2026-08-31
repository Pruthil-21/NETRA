import { Alert } from '@/types/alert';
import { authHeaders, unauthorizedError, isJwtConfigured } from '@/lib/apiAuth';

const WATCHLIST_API_URL = process.env.NEXT_PUBLIC_WATCHLIST_API_URL || 'http://localhost:8001';

export const alertsService = {
  async list(): Promise<Alert[]> {
    const response = await fetch(`${WATCHLIST_API_URL}/alerts`, {
      headers: authHeaders(),
      cache: 'no-store',
    });

    if (response.status === 401 && !isJwtConfigured()) throw unauthorizedError('fetch alerts');
    if (!response.ok) {
      throw new Error(`Failed to fetch alerts: ${response.statusText} (${response.status})`);
    }

    return response.json();
  },
};
