import { Alert, AlertHistoryEntry, AlertStatus } from '@/types/alert';
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
  // in place, it records a new status transition. reasonCode is required by
  // the backend when status is DISMISSED (a dismissed hit with no recorded
  // reason is an accountability gap) -- optional for every other status.
  async updateStatus(id: number, status: AlertStatus, reasonCode?: string): Promise<Alert> {
    const response = await fetch(`${WATCHLIST_API_URL}/alerts/${id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ status, ...(reasonCode ? { reason_code: reasonCode } : {}) }),
    });

    if (response.status === 401 && !isJwtConfigured()) throw unauthorizedError('update alert status');
    if (!response.ok) {
      throw new Error(`Failed to update alert: ${response.statusText} (${response.status})`);
    }

    return response.json();
  },

  // Who acknowledged/escalated/dismissed this alert (and when) -- feeds the
  // detail panel's history strip. Oldest first.
  async history(id: number): Promise<AlertHistoryEntry[]> {
    const response = await fetch(`${WATCHLIST_API_URL}/alerts/${id}/history`, {
      headers: authHeaders(),
      cache: 'no-store',
    });

    if (response.status === 401 && !isJwtConfigured()) throw unauthorizedError('fetch alert history');
    if (!response.ok) {
      throw new Error(`Failed to fetch alert history: ${response.statusText} (${response.status})`);
    }

    return response.json();
  },
};
