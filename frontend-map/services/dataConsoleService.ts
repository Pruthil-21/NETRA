// frontend-map/services/dataConsoleService.ts
// Client for the Data Console (registry-side import/export, phase 1) --
// backend-registry/app/routers/admin_ops.py's generic job engine, extended
// with real filters and real CSV/XLSX/JSON serialization.
import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';

export type DataConsoleFormat = 'csv' | 'json' | 'xlsx';

export type DataConsoleEntity =
  | 'cameras'
  | 'officers'
  | 'audit_logs'
  | 'postings'
  | 'registration_requests'
  | 'camera_status_history'
  | 'circles'
  | 'police_stations'
  | 'coverage_targets';

export interface DataJob {
  id: number;
  entity_type: string;
  direction: 'import' | 'export';
  format: string;
  status: string;
  total_rows: number;
  success_rows: number;
  failed_rows: number;
  row_results?: Record<string, unknown>[] | null;
  filters?: Record<string, unknown> | null;
  run_by: string | null;
  created_at: string;
}

async function parseErrorOrThrow(res: Response, label: string): Promise<never> {
  const body = await res.json().catch(() => null);
  throw new Error(body?.detail || `${label}: HTTP ${res.status}`);
}

export const dataConsoleService = {
  /** Row count for a filter set, without creating a job -- the live "N
   * rows match" line a filter panel updates against before an officer
   * commits to running the export. */
  async preview(entityType: DataConsoleEntity, filters: Record<string, unknown>): Promise<number> {
    const params = new URLSearchParams({ entity_type: entityType, filters: JSON.stringify(filters) });
    const res = await fetch(`${REGISTRY_API_URL}/admin/data-jobs/preview?${params.toString()}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return parseErrorOrThrow(res, 'Failed to preview export');
    const body = await res.json();
    return body.count;
  },

  async runExport(
    entityType: DataConsoleEntity,
    format: DataConsoleFormat,
    filters: Record<string, unknown>
  ): Promise<DataJob> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/data-jobs?direction=export`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ entity_type: entityType, format, filters }),
    });
    if (!res.ok) return parseErrorOrThrow(res, 'Failed to run export');
    return res.json();
  },

  async runImport(
    entityType: DataConsoleEntity,
    format: DataConsoleFormat,
    rows: Record<string, unknown>[]
  ): Promise<DataJob> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/data-jobs?direction=import`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ entity_type: entityType, format, rows }),
    });
    if (!res.ok) return parseErrorOrThrow(res, 'Failed to run import');
    return res.json();
  },

  async resubmitFailed(jobId: number): Promise<DataJob> {
    const res = await fetch(`${REGISTRY_API_URL}/admin/data-jobs/${jobId}/resubmit-failed`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) return parseErrorOrThrow(res, 'Failed to resubmit failed rows');
    return res.json();
  },

  async listJobs(entityType?: DataConsoleEntity, limit = 20): Promise<DataJob[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (entityType) params.set('entity_type', entityType);
    const res = await fetch(`${REGISTRY_API_URL}/admin/data-jobs?${params.toString()}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return parseErrorOrThrow(res, 'Failed to load job history');
    return res.json();
  },

  /** Triggers a real file download (CSV/XLSX/JSON) for an already-run job --
   * `format` optionally overrides the job's own stored format, so the same
   * export can be pulled again as a different file type without re-running
   * the query. */
  async download(jobId: number, entityType: string, format?: DataConsoleFormat): Promise<void> {
    const params = format ? `?format=${format}` : '';
    const res = await fetch(`${REGISTRY_API_URL}/admin/data-jobs/${jobId}/download${params}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return parseErrorOrThrow(res, 'Failed to download export');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${entityType}_${jobId}.${format || 'csv'}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },
};
