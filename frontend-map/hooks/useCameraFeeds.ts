"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CameraFeed } from "@/types/stream";
import { REGISTRY_API_URL } from "@/config/streams";
import { getCameraStreamUrl } from "@/lib/stream";
import { authorizedFetch, describeFetchError } from "@/lib/apiClient";

// Shape returned by GET /cameras on backend-registry (see contract/API_CONTRACT.md).
// Field is `long`, not `lng` — matches backend-registry/app/schemas.py exactly.
interface RegistryCamera {
  id: number;
  name: string;
  dept: string;
  lat: number;
  long: number;
  camera_type: string;
  ownership: string;
  connectivity_status: string;
  storage_type: string;
  retention_days: number;
  health_status: string;
  rtsp_url: string | null;
  stream_id: string | null;
  hls_url: string | null;
}

// connectivity_status/health_status are decided entirely server-side now, by
// backend-registry's own periodic sweep (see
// cameras_service.run_periodic_connectivity_sweep) -- this used to be only a
// pre-probe hint, with a second poll here re-checking every camera's stream
// directly from the browser every 8s. That probe (and CameraRegistryContext's
// own separate, differently-timed one) is exactly what made the Dashboard
// grid disagree with the Map/header about the same camera at the same
// moment, and couldn't scale past a small camera count. Now there is exactly
// one place that ever decides ONLINE/OFFLINE, and every surface (this grid
// included) just reads it.
export function resolveStatus(connectivityStatus: string, healthStatus: string): CameraFeed["status"] {
  const connectivity = (connectivityStatus || "").toLowerCase();
  const health = (healthStatus || "").toLowerCase();

  if (health === "degraded" || health === "down") return "DEGRADED";
  if (connectivity === "online") return "ONLINE";
  if (connectivity === "offline") return "OFFLINE";
  return "UNKNOWN";
}

const POLL_INTERVAL_MS = 20_000;
// How fresh the last successful GET /cameras fetch needs to be to trust
// what's on screen -- matches POLL_INTERVAL_MS now that this is a plain
// registry re-fetch, not a per-camera reachability probe.
export const FEED_STALE_THRESHOLD_MS = POLL_INTERVAL_MS;

interface UseCameraFeedsResult {
  feeds: CameraFeed[];
  loading: boolean;
  error: string | null;
  /** Re-runs the fetch immediately, independent of the poll interval — for a manual "Retry" button. */
  refetch: () => void;
  /** When the registry was last successfully re-fetched — pair with FEED_STALE_THRESHOLD_MS
   * to know whether what's on screen is still trustworthy. */
  lastUpdated: Date | null;
}

/** Fetches the live camera registry and maps it into this app's CameraFeed shape. */
export function useCameraFeeds(): UseCameraFeedsResult {
  const [feeds, setFeeds] = useState<CameraFeed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const cancelledRef = useRef(false);

  const fetchCameras = useCallback(async () => {
    try {
      const res = await authorizedFetch(`${REGISTRY_API_URL}/cameras`);
      if (!res.ok) throw new Error(`Registry API returned ${res.status}`);

      const data: RegistryCamera[] = await res.json();
      if (cancelledRef.current) return;

      setFeeds(
        data.map((cam) => ({
          id: String(cam.id),
          name: cam.name,
          department: cam.dept,
          location: `${cam.lat.toFixed(4)}, ${cam.long.toFixed(4)}`,
          lat: cam.lat,
          long: cam.long,
          // Same URL builder the hover-preview overlay and detail drawer use
          // (getCameraStreamUrl/lib/stream.ts) -- a separate, drifted builder
          // used to live here (config/streams.ts's buildHlsUrl), missing the
          // ?cookieCheck=1 MediaMTX/Cloudflare needs and guessing a URL from
          // the raw camera id when stream_id was empty instead of correctly
          // reporting "no stream." That's what let a tile look fine while
          // its own hover preview -- using the correct builder -- reported
          // the same camera unavailable.
          hlsUrl: getCameraStreamUrl({ hls_url: cam.hls_url, stream_id: cam.stream_id }).url ?? "",
          status: resolveStatus(cam.connectivity_status, cam.health_status),
        }))
      );
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      if (!cancelledRef.current) {
        setError(describeFetchError(err, "Failed to fetch camera registry"));
      }
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    fetchCameras();

    // Backend tunnels (Cloudflare Quick Tunnels) are known to drop mid-demo — poll so
    // the grid recovers on its own instead of requiring a manual page reload.
    const interval = setInterval(fetchCameras, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
    };
  }, [fetchCameras]);

  return { feeds, loading, error, refetch: fetchCameras, lastUpdated };
}
