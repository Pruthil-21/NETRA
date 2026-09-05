import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';

export interface CoverageTarget {
  id: number;
  name: string;
  lat: number;
  long: number;
  district: string;
  priority: string;
}

export interface GapAnalysisReport {
  uncovered_zones: {
    target_id: number;
    name: string;
    district: string;
    nearest_camera_id: number | null;
    distance_meters: number | null;
  }[];
  ageing_infrastructure: {
    camera_id: number;
    name: string;
    district: string;
    age_days: number;
    degraded_transition_count_90d: number;
  }[];
}

export async function fetchCoverageTargets(): Promise<CoverageTarget[]> {
  const res = await fetch(`${REGISTRY_API_URL}/coverage-targets`, { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`Registry API returned ${res.status}`);
  return res.json();
}

export async function createCoverageTarget(data: Omit<CoverageTarget, 'id'>): Promise<CoverageTarget> {
  const res = await fetch(`${REGISTRY_API_URL}/coverage-targets`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Registry API returned ${res.status}`);
  return res.json();
}

export async function deleteCoverageTarget(id: number): Promise<void> {
  const res = await fetch(`${REGISTRY_API_URL}/coverage-targets/${id}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) throw new Error(`Registry API returned ${res.status}`);
}

export async function fetchGapAnalysisReport(): Promise<GapAnalysisReport> {
  const res = await fetch(`${REGISTRY_API_URL}/reports/gap-analysis`, { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`Registry API returned ${res.status}`);
  return res.json();
}

export interface ReportSummary {
  total_cameras: number;
  cameras_by_department: Record<string, number>;
  cameras_by_connectivity_status: Record<string, number>;
  cameras_by_health_status: Record<string, number>;
  // null when backend-watchlist's schema hasn't been applied in this
  // environment yet -- see backend-registry's reports_service._count_last_24h.
  alerts_last_24h: number | null;
  detections_last_24h: number | null;
  blacklist_entries_last_24h: number | null;
  avg_alert_response_seconds: number | null;
}

export async function fetchReportSummary(): Promise<ReportSummary> {
  const res = await fetch(`${REGISTRY_API_URL}/reports/summary`, { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`Registry API returned ${res.status}`);
  return res.json();
}
