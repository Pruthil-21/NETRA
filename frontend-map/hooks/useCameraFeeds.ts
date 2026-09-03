"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

// The registry's own connectivity/health fields are set by hand (or default to
// "unknown"/"operational" placeholders) and go stale the moment a stream is
// swapped out — they're only used as a pre-probe hint (DEGRADED, and the
// immediate paint before the first reachability check resolves). The actual
// ONLINE/OFFLINE badge is decided by really fetching each camera's HLS
// manifest below, the same "trust a live check over a database column"
// approach CameraRegistryContext already uses for the map.
function hintStatus(connectivityStatus: string, healthStatus: string): CameraFeed["status"] {
  const connectivity = (connectivityStatus || "").toLowerCase();
  const health = (healthStatus || "").toLowerCase();

  if (health === "degraded" || health === "down") return "DEGRADED";
  if (connectivity === "offline") return "OFFLINE";
  return "UNKNOWN";
}

const POLL_INTERVAL_MS = 20_000;
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
// The reachability probe is what actually drives ONLINE/OFFLINE, so it's the
// cadence a "how fresh is this badge" indicator should be measured against.
export const FEED_STALE_THRESHOLD_MS = HEALTH_CHECK_INTERVAL_MS;

async function probeStreamReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", cache: "no-store", signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

interface UseCameraFeedsResult {
  feeds: CameraFeed[];
  loading: boolean;
  error: string | null;
  /** Re-runs the fetch immediately, independent of the poll interval — for a manual "Retry" button. */
  refetch: () => void;
  /** When the reachability probe last completed a full pass — pair with FEED_STALE_THRESHOLD_MS
   * to know whether what's on screen is still trustworthy. */
  lastUpdated: Date | null;
}

// Reachability truth (once known) overrides the registry's DB hint entirely for
// ONLINE/OFFLINE; DEGRADED stays a DB-only signal (the stream can be reachable but
// still flagged degraded by whoever's monitoring the camera hardware itself).
// A pure function (not inlined in the useMemo) so it's directly unit-testable, and
// so its one deliberate performance property -- returning the SAME feed object
// when the resolved status didn't change -- is explicit and easy to verify without
// rendering anything. That reference stability is what lets React.memo on FeedCard
// (see components/dashboard/FeedCard.tsx) actually skip re-rendering tiles whose
// status hasn't moved on this poll tick.
export function mergeFeedStatus(
  rawFeeds: CameraFeed[],
  reachability: Record<string, boolean>
): CameraFeed[] {
  return rawFeeds.map((feed) => {
    if (feed.status === "DEGRADED") return feed;
    const reachable = reachability[feed.id];
    if (reachable === undefined) return feed;
    const resolvedStatus = reachable ? ("ONLINE" as const) : ("OFFLINE" as const);
    if (feed.status === resolvedStatus) return feed;
    return { ...feed, status: resolvedStatus };
  });
}

/** Fetches the live camera registry and maps it into this app's CameraFeed shape. */
export function useCameraFeeds(): UseCameraFeedsResult {
  const [rawFeeds, setRawFeeds] = useState<CameraFeed[]>([]);
  const [reachability, setReachability] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const cancelledRef = useRef(false);
  const rawFeedsRef = useRef<CameraFeed[]>([]);

  const fetchCameras = useCallback(async () => {
    try {
      const res = await authorizedFetch(`${REGISTRY_API_URL}/cameras`);
      if (!res.ok) throw new Error(`Registry API returned ${res.status}`);

      const data: RegistryCamera[] = await res.json();
      if (cancelledRef.current) return;

      setRawFeeds(
        data.map((cam) => ({
          id: String(cam.id),
          name: cam.name,
          department: cam.dept,
          location: `${cam.lat.toFixed(4)}, ${cam.long.toFixed(4)}`,
          lat: cam.lat,
          long: cam.long,
          hlsUrl: buildHlsUrl(cam.id, cam.stream_id, cam.hls_url),
          status: hintStatus(cam.connectivity_status, cam.health_status),
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

  useEffect(() => {
    rawFeedsRef.current = rawFeeds;
  }, [rawFeeds]);

  // Real reachability check, independent of the registry poll above — a camera's
  // manifest can start/stop responding between registry syncs, so this runs on its
  // own faster interval and keeps checking every camera currently on screen.
  useEffect(() => {
    let cancelled = false;

    const checkAll = async () => {
      const snapshot = rawFeedsRef.current;
      const results = await Promise.allSettled(
        snapshot.map(async (feed) => [feed.id, await probeStreamReachable(feed.hlsUrl)] as const)
      );
      if (cancelled) return;
      setReachability((prev) => {
        const next = { ...prev };
        for (const r of results) {
          if (r.status === "fulfilled") next[r.value[0]] = r.value[1];
        }
        return next;
      });
      setLastUpdated(new Date());
    };

    checkAll();
    const interval = setInterval(checkAll, HEALTH_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const feeds = useMemo(() => mergeFeedStatus(rawFeeds, reachability), [rawFeeds, reachability]);

  return { feeds, loading, error, refetch: fetchCameras, lastUpdated };
}
