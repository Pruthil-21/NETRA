import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';

/** Read-only District -> Taluka -> Village reference hierarchy (Government
 * of India's Local Government Directory -- see
 * backend-registry/scripts/build_data/fetch_gujarat_locations.py for
 * provenance). Never created/edited/deleted through the app -- "Area" is
 * the user-managed layer on top of this. */
export interface District {
  id: number;
  name: string;
  lgd_code: string | null;
}

export interface Taluka {
  id: number;
  name: string;
  district_id: number;
  /** True for the 2 talukas (Rah, Dharnidhar, under Vav-Tharad) that don't
   * exist in the source dataset -- a taluka split newer than its 2022
   * retrieval date. Surfaced so an officer knows village-level data is
   * genuinely missing here, not just empty. */
  no_lgd_data: boolean;
}

export interface Village {
  id: number;
  name: string;
  taluka_id: number;
  is_urban: boolean;
}

export const locationsService = {
  async listDistricts(): Promise<District[]> {
    const res = await fetch(`${REGISTRY_API_URL}/districts`, { headers: authHeaders(), cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to fetch districts: HTTP ${res.status}`);
    return res.json();
  },

  async listTalukas(districtId: number): Promise<Taluka[]> {
    const res = await fetch(`${REGISTRY_API_URL}/talukas?district_id=${districtId}`, {
      headers: authHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Failed to fetch talukas: HTTP ${res.status}`);
    return res.json();
  },

  async searchVillages(params: { talukaId?: number; search?: string; limit?: number }): Promise<Village[]> {
    const query = new URLSearchParams();
    if (params.talukaId != null) query.set('taluka_id', String(params.talukaId));
    if (params.search) query.set('search', params.search);
    if (params.limit != null) query.set('limit', String(params.limit));
    const res = await fetch(`${REGISTRY_API_URL}/villages?${query.toString()}`, {
      headers: authHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Failed to fetch villages: HTTP ${res.status}`);
    return res.json();
  },
};
