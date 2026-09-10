// Congestion alerts (density/flow threshold breaches) -- see
// backend-watchlist/app/routers/traffic_alerts.py. A separate model from
// alertsService.ts's watchlist plate-match alerts (see schema.sql's
// traffic_alerts table for why), though delivery is pushed over the same
// WS channel -- see useAlertsStream and its `kind` discriminator.
import { authHeaders, unauthorizedError, isJwtConfigured } from '@/lib/apiAuth';

const WATCHLIST_API_URL = process.env.NEXT_PUBLIC_WATCHLIST_API_URL || 'http://localhost:8001';

export type TrafficAlertStatus = 'NEW' | 'ACKNOWLEDGED' | 'DISMISSED';

export interface TrafficAlert {
  id: number;
  alert_type: 'density' | 'flow';
  camera_id: number | null;
  from_camera_id: number | null;
  to_camera_id: number | null;
  metric_value: number;
  threshold_value: number;
  district: string | null;
  status: TrafficAlertStatus;
  triggered_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
}

export const trafficAlertsService = {
  async list(status?: TrafficAlertStatus): Promise<TrafficAlert[]> {
    const params = status ? `?status=${status}` : '';
    const response = await fetch(`${WATCHLIST_API_URL}/traffic-alerts${params}`, {
      headers: authHeaders(),
      cache: 'no-store',
    });

    if (response.status === 401 && !isJwtConfigured()) throw unauthorizedError('fetch traffic alerts');
    if (!response.ok) {
      throw new Error(`Failed to fetch traffic alerts: ${response.statusText} (${response.status})`);
    }
    return response.json();
  },

  async updateStatus(id: number, status: 'ACKNOWLEDGED' | 'DISMISSED'): Promise<TrafficAlert> {
    const response = await fetch(`${WATCHLIST_API_URL}/traffic-alerts/${id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ status }),
    });

    if (response.status === 401 && !isJwtConfigured()) throw unauthorizedError('update traffic alert status');
    if (!response.ok) {
      throw new Error(`Failed to update traffic alert: ${response.statusText} (${response.status})`);
    }
    return response.json();
  },
};
