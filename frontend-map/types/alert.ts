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
