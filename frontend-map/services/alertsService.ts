import { Alert, AlertStatus } from '@/types/alert';
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

  // Append-only on the backend (see backend-watchlist/app/schema.sql's
  // alert_status_history) -- this PATCH never edits the original alert row
  // in place, it records a new status transition.
  async updateStatus(id: number, status: AlertStatus): Promise<Alert> {
    const response = await fetch(`${WATCHLIST_API_URL}/alerts/${id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ status }),
    });

    if (response.status === 401 && !isJwtConfigured()) throw unauthorizedError('update alert status');
    if (!response.ok) {
      throw new Error(`Failed to update alert: ${response.statusText} (${response.status})`);
    }

    return response.json();
  },
};
