import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';

export interface PoliceStation {
  id: number;
  name: string;
  lat: number;
  long: number;
  district: string;
  contact: string | null;
}

export async function fetchPoliceStations(): Promise<PoliceStation[]> {
  const res = await fetch(`${REGISTRY_API_URL}/police-stations`, { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`Registry API returned ${res.status}`);
  return res.json();
}
