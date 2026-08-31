"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CameraFeed } from "@/types/stream";
import { REGISTRY_API_URL, buildHlsUrl } from "@/config/streams";
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

// Only a confirmed "online" + "healthy" pair earns a confident ONLINE badge. Anything
// else that isn't explicitly offline/degraded/down — including the DB's own "unknown"
// default — is UNKNOWN rather than assumed live.
function mapStatus(connectivityStatus: string, healthStatus: string): CameraFeed["status"] {
  const connectivity = (connectivityStatus || "").toLowerCase();
  const health = (healthStatus || "").toLowerCase();

  if (connectivity === "offline") return "OFFLINE";
  if (health === "degraded" || health === "down") return "DEGRADED";
  if (connectivity === "online" && health === "healthy") return "ONLINE";
  return "UNKNOWN";
}

const POLL_INTERVAL_MS = 20_000;

interface UseCameraFeedsResult {
  feeds: CameraFeed[];
  loading: boolean;
  error: string | null;
  /** Re-runs the fetch immediately, independent of the poll interval — for a manual "Retry" button. */
  refetch: () => void;
}

/** Fetches the live camera registry and maps it into this app's CameraFeed shape. */
export function useCameraFeeds(): UseCameraFeedsResult {
  const [feeds, setFeeds] = useState<CameraFeed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
          hlsUrl: buildHlsUrl(cam.id, cam.stream_id, cam.hls_url),
          status: mapStatus(cam.connectivity_status, cam.health_status),
        }))
      );
      setError(null);
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

  return { feeds, loading, error, refetch: fetchCameras };
}
