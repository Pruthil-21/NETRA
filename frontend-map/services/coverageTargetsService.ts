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

export interface PlacementSuggestion {
  suggested_at_target_id: number;
  suggested_at_name: string;
  district: string;
  lat: number;
  long: number;
  covers_target_ids: number[];
  priority_weighted_score: number;
}

export interface GapAnalysisReport {
  uncovered_zones: {
    target_id: number;
    name: string;
    district: string;
    priority: string;
    nearest_camera_id: number | null;
    distance_meters: number | null;
  }[];
  ageing_infrastructure: {
    camera_id: number;
    name: string;
    district: string;
    age_days: number;
    degraded_transition_count_90d: number;
    risk_level: string;
  }[];
  placement_suggestions: PlacementSuggestion[];
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

// The export endpoint needs the same Authorization header as every other
// registry call, so a plain <a href> can't hit it directly (a bare
// cross-origin GET would carry no auth and 401). Fetched as a Blob and
// opened in a new tab instead -- the report is meant to be read/printed
// (see backend's Content-Disposition: inline), not silently saved, so a
// viewable tab is the right target, not a forced file download.
export async function openGapAnalysisReport(): Promise<void> {
  const res = await fetch(`${REGISTRY_API_URL}/reports/gap-analysis/export`, {
    headers: authHeaders(),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Registry API returned ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  // Revoked after a delay, not immediately -- the new tab needs the blob
  // URL to still resolve by the time it finishes loading.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
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
