"use client";

import { useEffect, useState } from "react";
import { CameraFeed } from "@/types/stream";
import { REGISTRY_API_URL, buildHlsUrl } from "@/config/streams";

// Shape returned by GET /cameras on backend-registry (see contract/API_CONTRACT.md).
interface RegistryCamera {
  id: number;
  name: string;
  dept: string;
  lat: number;
  lng: number;
  camera_type: string;
  ownership: string;
  connectivity_status: string;
  storage_type: string;
  retention_days: number;
  health_status: string;
  rtsp_url: string | null;
}

function mapStatus(connectivityStatus: string, healthStatus: string): CameraFeed["status"] {
  const connectivity = (connectivityStatus || "").toLowerCase();
  const health = (healthStatus || "").toLowerCase();

  if (connectivity === "offline") return "OFFLINE";
  if (health === "degraded" || health === "down") return "DEGRADED";
  return "ONLINE";
}

interface UseCameraFeedsResult {
  feeds: CameraFeed[];
  loading: boolean;
  error: string | null;
}

/** Fetches the live camera registry and maps it into this app's CameraFeed shape. */
export function useCameraFeeds(): UseCameraFeedsResult {
  const [feeds, setFeeds] = useState<CameraFeed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchCameras() {
      try {
        const res = await fetch(`${REGISTRY_API_URL}/cameras`);
        if (!res.ok) throw new Error(`Registry API returned ${res.status}`);

        const data: RegistryCamera[] = await res.json();
        if (cancelled) return;

        setFeeds(
          data.map((cam) => ({
            id: String(cam.id),
            name: cam.name,
            department: cam.dept,
            location: `${cam.lat.toFixed(4)}, ${cam.lng.toFixed(4)}`,
            hlsUrl: buildHlsUrl(cam.id),
            status: mapStatus(cam.connectivity_status, cam.health_status),
          }))
        );
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to fetch camera registry");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchCameras();
    return () => {
      cancelled = true;
    };
  }, []);

  return { feeds, loading, error };
}
