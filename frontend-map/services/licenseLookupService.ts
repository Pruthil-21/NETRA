import { SarathiDetails } from '@/types/ownerDetails';
import { authHeaders, unauthorizedError, isJwtConfigured } from '@/lib/apiAuth';

const WATCHLIST_API_URL =
  process.env.NEXT_PUBLIC_WATCHLIST_API_URL || 'http://localhost:8001';

export const licenseLookupService = {
  // Manual driving-license lookup (SARTHI, currently a placeholder -- see
  // govt_lookup_service.py). Keyed on a DL number an officer types in
  // directly -- unrelated to plates/cameras/alerts.
  async lookup(dlNumber: string): Promise<SarathiDetails> {
    const response = await fetch(
      `${WATCHLIST_API_URL}/license-lookup/${encodeURIComponent(dlNumber)}`,
      { headers: authHeaders(), cache: 'no-store' }
    );

    if (response.status === 401 && !isJwtConfigured()) throw unauthorizedError('fetch license details');
    if (!response.ok) {
      throw new Error(`Failed to fetch license details: ${response.statusText} (${response.status})`);
    }

    return response.json();
  },
};
