// A single confirmed plate sighting, as returned by backend-watchlist's
// GET /detections (contract/API_CONTRACT.md, Model 2). Ordered ascending
// by detected_at when returned from a search — a timeline/route view.
export interface Detection {
  id: number;
  plate_number: string;
  camera_id: number;
  detected_at: string;
  confidence: number | null;
}

export interface DetectionSearchParams {
  plate_number?: string;
  camera_id?: number;
  from?: string;
  to?: string;
}
