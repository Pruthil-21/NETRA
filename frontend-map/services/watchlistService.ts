import { WatchlistEntry, WatchlistCreateInput } from '@/types/alert';
import { authHeaders, unauthorizedError, isJwtConfigured } from '@/lib/apiAuth';

const WATCHLIST_API_URL = process.env.NEXT_PUBLIC_WATCHLIST_API_URL || 'http://localhost:8001';

export const watchlistService = {
  async list(): Promise<WatchlistEntry[]> {
    const response = await fetch(`${WATCHLIST_API_URL}/watchlist`, {
      headers: authHeaders(),
      cache: 'no-store',
    });

    if (response.status === 401 && !isJwtConfigured()) throw unauthorizedError('fetch watchlist');
    if (!response.ok) {
      throw new Error(`Failed to fetch watchlist: ${response.statusText} (${response.status})`);
    }

    return response.json();
  },

  async create(entry: WatchlistCreateInput): Promise<WatchlistEntry> {
    const response = await fetch(`${WATCHLIST_API_URL}/watchlist`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(entry),
    });

    if (response.status === 401 && !isJwtConfigured()) throw unauthorizedError('add plate to watchlist');
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Failed to add plate to watchlist: ${response.statusText} (${response.status}) ${detail}`);
    }

    return response.json();
  },
};
