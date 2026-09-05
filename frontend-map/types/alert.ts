import { VehicleGovtLookup } from './ownerDetails';

// Mirrors backend-watchlist's AlertOut/WatchlistOut (contract/API_CONTRACT.md)
// -- created server-side as a side effect of POST /detections whenever a
// confirmed plate read matches an active watchlist entry.
export type AlertStatus = 'NEW' | 'ACKNOWLEDGED' | 'DISMISSED' | 'ESCALATED';

export interface Alert {
  id: number;
  camera_id: number;
  plate_number: string;
  watchlist_id: number;
  detection_id: number | null;
  matched_at: string;
  status: AlertStatus;
  // Attached server-side at read time: combined VAHAN (ownership) +
  // eGujCop (crime/FIR) lookup -- always present, but each `status`
  // inside stays "not_configured" until real access exists.
  // See govt_lookup_service.py.
  owner_details?: VehicleGovtLookup | null;
  // Attached server-side (alerts_service._with_nearest_station) via a real
  // PostGIS distance calculation from the alert's camera -- null only when
  // the environment has zero police_stations rows configured yet.
  nearest_station?: { name: string; distance_meters: number } | null;
}

export type WatchlistPriority = 'low' | 'medium' | 'high';

export interface WatchlistEntry {
  id: number;
  plate_number: string;
  reason: string;
  dept_flagged: string;
  priority: WatchlistPriority;
  date_added: string;
}

export interface WatchlistCreateInput {
  plate_number: string;
  reason: string;
  dept_flagged: string;
  priority: WatchlistPriority;
}
