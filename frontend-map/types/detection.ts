// A single confirmed plate sighting, as returned by backend-watchlist's
// GET /detections (contract/API_CONTRACT.md, Model 2). Ordered ascending
// by detected_at when returned from a search — a timeline/route view.
//
// The fields below `confidence` are specific to the vehicle-trace demo's
// GET /vehicle-traces/{plate}?scenario_run_id=... endpoint (Anushka's
// contract, not yet live server-side as of this writing) — optional
// because the general-purpose GET /detections response doesn't carry them.
// camera_name/latitude/longitude/stream_id there are an explicitly
// temporary, hardcoded-server-side stub for cameras 101/102/103 — treated
// as a fallback below the frontend's own camera registry, never as the
// primary source (see lib/resolveSightingCamera.ts).
export interface Detection {
  id: number;
  plate_number: string;
  camera_id: number;
  detected_at: string;
  confidence: number | null;
  camera_name?: string;
  latitude?: number;
  longitude?: number;
  stream_id?: string | number;
  scenario_run_id?: string;
  source?: string;
  /** Route caption for this scenario run (e.g. "Inferred route from
   * simulated camera sightings"), from GET /vehicle-traces' top-level
   * `label`. Only present on scenario-run results. */
  route_label?: string;
}

/** Raw shape of one entry in GET /vehicle-traces' `sightings` array --
 * no `id` or `plate_number` per-item, both live at the response's top
 * level instead. See detectionService.search's scenario-run branch for
 * how this gets mapped into a Detection. */
interface RawVehicleTraceSighting {
  camera_id: number;
  camera_name?: string;
  latitude?: number;
  longitude?: number;
  stream_id?: string | number;
  detected_at: string;
  confidence: number | null;
}

export interface RawVehicleTraceResponse {
  scenario_run_id: string;
  plate: string;
  label?: string;
  sightings: RawVehicleTraceSighting[];
}

export interface DetectionSearchParams {
  plate_number?: string;
  camera_id?: number;
  from?: string;
  to?: string;
  /** Switches detectionService.search to the vehicle-trace demo endpoint,
   * scoped to one replay run instead of a plate's entire sighting history. */
  scenario_run_id?: string;
}
