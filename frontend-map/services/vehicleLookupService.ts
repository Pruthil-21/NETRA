import { VehicleGovtLookup } from '@/types/ownerDetails';
import { authHeaders, unauthorizedError, isJwtConfigured } from '@/lib/apiAuth';

// backend-watchlist, not backend-registry -- same service as detectionService/
// alertsService, see NEXT_PUBLIC_WATCHLIST_API_URL in .env.example.
const WATCHLIST_API_URL =
  process.env.NEXT_PUBLIC_WATCHLIST_API_URL || 'http://localhost:8001';

export const vehicleLookupService = {
  // Manual "who owns this plate + any police record" lookup (VAHAN +
  // eGujCop, currently placeholders -- see govt_lookup_service.py).
  // Distinct from detectionService.search, which returns sighting history
  // rather than registry/police details.
  async lookup(plateNumber: string): Promise<VehicleGovtLookup> {
    const response = await fetch(
      `${WATCHLIST_API_URL}/vehicle-lookup/${encodeURIComponent(plateNumber)}`,
      { headers: authHeaders(), cache: 'no-store' }
    );

    if (response.status === 401 && !isJwtConfigured()) throw unauthorizedError('fetch vehicle owner details');
    if (!response.ok) {
      throw new Error(`Failed to fetch owner details: ${response.statusText} (${response.status})`);
    }

    return response.json();
  },
};
