export interface CameraFeed {
  id: string;
  name: string;
  department: string;
  location: string;
  // Raw coordinates, kept alongside the formatted `location` string so the UI can
  // build a "view on map" link — an officer can't act on "22.9938, 72.6035" as text.
  lat: number;
  long: number;
  hlsUrl: string;
  // UNKNOWN = registry hasn't confirmed connectivity/health yet (e.g. the DB's own
  // "unknown" default) — distinct from a confirmed-healthy ONLINE camera.
  status: "ONLINE" | "OFFLINE" | "DEGRADED" | "UNKNOWN";
}