import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';

export interface CameraHealthMetrics {
  cpu_percent: number;
  memory_percent: number;
  network_mbps: number;
  temperature_celsius: number;
}

export interface CameraHealthDevice {
  id: string;
  name: string;
  status: string;
  reachable: boolean;
  snmp_mode: string;
  snmp_state: string;
  metrics: CameraHealthMetrics | null;
  last_checked_at: string;
}

/** GET /cameras/{id}/health -- backed by the standalone mock SNMP monitor
 * (streaming/snmp/monitor.py). A 404 means "nothing to show" (the monitor
 * isn't running, or has no device for this camera) rather than an error --
 * it's optional demo infrastructure, not a required part of the registry. */
export async function getCameraHealth(cameraId: number): Promise<CameraHealthDevice | null> {
  const res = await fetch(`${REGISTRY_API_URL}/cameras/${cameraId}/health`, {
    headers: authHeaders(),
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load device health: HTTP ${res.status}`);
  return res.json();
}
