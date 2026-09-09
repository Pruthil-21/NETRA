// frontend-map/services/federationService.ts
// Talks only to our own backend-registry's /federation/* proxy
// (backend-registry/app/federation_proxy.py) -- never to the middleware
// service directly. The proxy adds our RBAC/district scoping and holds the
// federation service credential server-side; the browser never sees it.
import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';

export type FederationSourceStatus = 'initializing' | 'connected' | 'retrying' | 'unknown';

export interface FederationSource {
  id: string;
  status: string;
  next_due: string | null;
  queued_until: string | null;
  last_attempt: string | null;
  last_success: string | null;
  last_full: string | null;
  duration_ms: number | null;
  changed: number;
  camera_count: number;
  failures: number;
  total_failures: number;
  error_code: string | null;
  overdue: boolean;
}

export interface FederationCamera {
  id: string;
  source_id: string;
  external_id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  playback_url: string | null;
  status: string;
  status_basis: string;
  representative: boolean;
  stale: boolean;
  /** Existing registry camera this inventory row is already mapped to, if
   * any -- null means unmapped (only visible here to manage_cameras users;
   * district-scoped viewers never see unmapped rows at all, per the proxy). */
  registry_camera_id: number | null;
}

interface FederationCamerasPage {
  items: FederationCamera[];
  next_cursor: string | null;
}

/** Body for PUT /federation/sources/{id} -- mirrors the federation
 * service's own Source model (middleware/federation/models.py), minus
 * `id` (that comes from the URL path, never the body). `headers_env`,
 * `login_email_env` and `login_password_env` are ENVIRONMENT VARIABLE
 * NAMES, not secret values -- the actual credentials must already exist
 * in the federation container's environment (.env.federation); this form
 * can only reference them, never set them. */
export interface FederationSourceInput {
  name: string;
  adapter: 'organizer' | 'mediamtx' | 'delta';
  inventory_url: string;
  playback_base: string;
  headers_env?: string | null;
  path_prefix?: string;
  playback_template?: string;
  representative?: boolean;
  playback_available?: boolean;
  force_ipv4?: boolean;
  login_url?: string | null;
  login_email_env?: string | null;
  login_password_env?: string | null;
  sync_interval_seconds?: number;
  full_reconcile_seconds?: number;
}

async function parseErrorOrThrow(res: Response, label: string): Promise<never> {
  const body = await res.json().catch(() => null);
  throw new Error(body?.detail || `${label}: HTTP ${res.status}`);
}

export const federationService = {
  async listSources(): Promise<FederationSource[]> {
    const res = await fetch(`${REGISTRY_API_URL}/federation/sources`, { headers: authHeaders() });
    if (!res.ok) return parseErrorOrThrow(res, 'Failed to fetch federation sources');
    const body = await res.json();
    return body.items;
  },

  async syncSource(sourceId: string): Promise<void> {
    const res = await fetch(`${REGISTRY_API_URL}/federation/sources/${encodeURIComponent(sourceId)}/sync`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) return parseErrorOrThrow(res, 'Failed to trigger source sync');
  },

  /** Fetches every page of the unified camera inventory. Keyset-paginated
   * (max 500/page server-side); a district-filtered page can legitimately
   * come back empty while still carrying a next_cursor, so pagination must
   * continue until next_cursor is null, not stop on an empty items array. */
  async listAllCameras(): Promise<FederationCamera[]> {
    const items: FederationCamera[] = [];
    let after = '';
    // 50 pages * 500/page = 25,000 cameras -- comfortably above any real
    // deployment's inventory. A hard cap here just stops a backend bug
    // (e.g. next_cursor never going null) from hanging the admin console
    // in an unbounded fetch loop; it's not an expected real limit.
    for (let page_num = 0; page_num < 50; page_num++) {
      const qs = new URLSearchParams({ limit: '500' });
      if (after) qs.set('after', after);
      const res = await fetch(`${REGISTRY_API_URL}/federation/cameras?${qs.toString()}`, { headers: authHeaders() });
      if (!res.ok) return parseErrorOrThrow(res, 'Failed to fetch federation camera inventory');
      const page: FederationCamerasPage = await res.json();
      items.push(...page.items);
      if (!page.next_cursor) break;
      after = page.next_cursor;
    }
    return items;
  },

  async createMapping(cameraId: string, registryCameraId: number): Promise<void> {
    const res = await fetch(`${REGISTRY_API_URL}/federation/mappings`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ camera_id: cameraId, registry_camera_id: registryCameraId }),
    });
    if (!res.ok) return parseErrorOrThrow(res, 'Failed to map camera');
  },

  /** The full config an edit form pre-fills from -- listSources() only
   * returns sync status, never the actual source configuration. */
  async getSourceConfig(sourceId: string): Promise<FederationSourceInput> {
    const res = await fetch(`${REGISTRY_API_URL}/federation/sources/${encodeURIComponent(sourceId)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return parseErrorOrThrow(res, 'Failed to load source config');
    return res.json();
  },

  /** Adds a new source (unknown id) or edits an existing one (same id) --
   * the federation service upserts either way. A validation failure there
   * (bad URL, missing login fields, etc.) currently surfaces here only as
   * a generic "Inventory service unavailable", not the specific reason --
   * double-check the payload against middleware/federation/models.py if
   * this fails. */
  async upsertSource(sourceId: string, input: FederationSourceInput): Promise<void> {
    const res = await fetch(`${REGISTRY_API_URL}/federation/sources/${encodeURIComponent(sourceId)}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(input),
    });
    if (!res.ok) return parseErrorOrThrow(res, 'Failed to save source');
  },

  /** Disables the source -- never a hard delete. Its cameras/mappings and
   * sync history are preserved; re-adding the same id later (upsertSource)
   * picks the schedule back up instead of starting cold. */
  async deleteSource(sourceId: string): Promise<void> {
    const res = await fetch(`${REGISTRY_API_URL}/federation/sources/${encodeURIComponent(sourceId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!res.ok) return parseErrorOrThrow(res, 'Failed to remove source');
  },
};
