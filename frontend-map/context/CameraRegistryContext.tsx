'use client';

import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { Camera, ConnectivityStatus } from '@/types/camera';
import { CameraFilters } from '@/types/filters';
import { OrganizerCamera } from '@/types/organizerCamera';
import { organizerCameraToCamera } from '@/lib/organizerCameras';
import { TEST_CCTV_CAMERAS } from '@/lib/testCameras';
import { VEHICLE_TRACE_DEMO_CAMERAS } from '@/lib/vehicleTraceCameras';
import { loadManualCameras, saveManualCameras, nextManualId } from '@/lib/manualCameras';
import { getCameraStreamUrl } from '@/lib/stream';
import { getWebRtcWhepUrl } from '@/lib/webrtc';
import { authHeaders } from '@/lib/apiAuth';

// backend-registry is the only live camera source now — the organizer's direct
// live.corp8.cloud API (previously fetched via /api/organizer-cameras) has been
// retired: it 502s permanently, and the organizer's 30 cameras are relayed
// through our own Cloudflare tunnel and registered in backend-registry instead
// (see backend-registry/scripts/seed_cameras.py history / stream_id
// `organizer-cam01`..`organizer-cam30`). GET /cameras always requires a bearer
// token (any role), same as the rest of the registry API -- see
// backend-registry/app/auth.py.
// The cameras array is assembled from four independent sources (registry API,
// manually-entered, the fixed test rig, the fixed vehicle-trace demo) that don't
// know about each other's ids. TEST_CCTV_CAMERAS (9000+) and VEHICLE_TRACE_DEMO_CAMERAS
// (101-103) are *reserved* ranges by convention, but nothing enforced that against
// the registry's own auto-incrementing ids -- which is exactly how registry cameras
// landed on 101/102/103 once already, producing a duplicate React key crash on every
// map/marker render. This dedupes by id, keeping the *last* occurrence -- callers
// list the reserved/fixed arrays last specifically so they always win a collision
// over a same-id registry/manual entry, never the other way around.
function mergeCameraSources(...sources: Camera[][]): Camera[] {
  const byId = new Map<number, Camera>();
  for (const source of sources) {
    for (const cam of source) {
      if (byId.has(cam.id) && process.env.NODE_ENV !== 'production') {
        console.warn(
          `[CameraRegistryContext] duplicate camera id ${cam.id} ("${byId.get(cam.id)!.name}" vs "${cam.name}") -- keeping the latter, dropping the former`
        );
      }
      byId.set(cam.id, cam);
    }
  }
  return Array.from(byId.values());
}

async function fetchRegistryCameras(): Promise<Camera[]> {
  const base = process.env.NEXT_PUBLIC_REGISTRY_API_URL || 'http://localhost:8000';
  const res = await fetch(`${base}/cameras`, { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`Registry API returned ${res.status}`);
  return res.json();
}

// How often every camera (not just the one an officer has open) gets a real
// reachability check, and how long each check can take before it's counted
// as offline. A plain GET on the manifest/playlist URL — no video decode —
// so checking dozens of cameras in parallel stays cheap.
export const HEALTH_CHECK_INTERVAL_MS = 20000;
const HEALTH_CHECK_TIMEOUT_MS = 5000;

async function probeStreamReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', cache: 'no-store', signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// WHEP endpoints are cross-origin here (MediaMTX on the Tailscale host, app
// on localhost) and typically only implement POST, so a plain GET can both
// CORS-fail and 405 even when the server is fully reachable -- neither is a
// real "offline" signal. `no-cors` sidesteps both: the response is opaque
// (we can't and don't need to read it), but fetch() only throws on an
// actual network-level failure (refused/timeout/DNS), which is exactly the
// "is this host:port up" signal we want.
async function probeWebRtcReachable(whepUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    await fetch(whepUrl, { method: 'GET', mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

interface RegistryContextType {
  cameras: Camera[];
  filteredCameras: Camera[];
  selectedCamera: Camera | null;
  filters: CameraFilters;
  isLoading: boolean;
  error: string | null;
  /** When the reachability health-check last completed a full pass over every camera --
   * pair with HEALTH_CHECK_INTERVAL_MS to know whether connectivity_status is still fresh. */
  lastUpdated: Date | null;
  setSelectedCamera: (cam: Camera | null) => void;
  setFilters: React.Dispatch<React.SetStateAction<CameraFilters>>;
  refreshCameras: () => Promise<void>;
  updateCameraConnectivity: (id: number, status: ConnectivityStatus) => void;
  /** Adds one manually-entered camera (raw backend shape). Auto-assigns an id
   * in the 8000-8999 range when the given id is blank or already taken. */
  addCamera: (raw: OrganizerCamera) => void;
  /** Bulk-imports many cameras at once (CSV/JSON upload), same id rules as addCamera. */
  importCameras: (raws: OrganizerCamera[]) => void;
}

const initialFilters: CameraFilters = {
  department: 'All Departments',
  connectivity: 'all',
  health: 'all',
  searchQuery: '',
};

const CameraRegistryContext = createContext<RegistryContextType | undefined>(undefined);

export function CameraRegistryProvider({ children }: { children: React.ReactNode }) {
  // The scale demo (/scale) is an isolated synthetic-data control plane --
  // its whole point is exercising the registry API at 80,000-row scale in
  // deliberate separation from the real camera fleet. This provider still
  // has to wrap /scale (AppShell's StatusTicker reads `cameras` from this
  // same context for the top-bar chrome shared by every route), but the
  // real-camera fetch and its 20s reachability poll are pure overhead there
  // -- and worse, concurrent network traffic that skews the demo's own
  // metrics panel. Gating on pathname is the minimal fix: skip firing them
  // while on /scale, without changing this provider's shape for any other
  // route.
  const pathname = usePathname();
  const isScaleRoute = pathname?.startsWith('/scale') ?? false;

  const [cameras, setCameras] = useState<Camera[]>([]);
  const [manualCameras, setManualCameras] = useState<OrganizerCamera[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);
  const [filters, setFilters] = useState<CameraFilters>(initialFilters);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const refreshCameras = useCallback(async () => {
    setIsLoading(true);
    // backend-registry being unreachable shouldn't blank the manual, test-rig,
    // and vehicle-trace-demo cameras, none of which need that network call --
    // same "one source failing doesn't blank the others" rule as before.
    let registryCameras: Camera[] = [];
    try {
      registryCameras = await fetchRegistryCameras();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load camera registry');
    }
    const manual = loadManualCameras();
    setManualCameras(manual);
    setCameras(
      mergeCameraSources(
        registryCameras,
        manual.map(organizerCameraToCamera),
        TEST_CCTV_CAMERAS,
        VEHICLE_TRACE_DEMO_CAMERAS
      )
    );
    setIsLoading(false);
  }, []);

  // Officer-entered cameras (single-add or bulk import) are appended locally
  // and persisted immediately — no need to re-hit the organizer API, which
  // would add latency and could momentarily drop what was just added if that
  // fetch failed.
  const commitManualCameras = useCallback((updatedManual: OrganizerCamera[]) => {
    setManualCameras(updatedManual);
    saveManualCameras(updatedManual);
    setCameras((prev) => {
      const withoutOldManual = prev.filter((c) => c.id < 8000 || c.id > 8999);
      return mergeCameraSources(withoutOldManual, updatedManual.map(organizerCameraToCamera));
    });
  }, []);

  const addCamera = useCallback(
    (raw: OrganizerCamera) => {
      const idTaken = cameras.some((c) => String(c.id) === raw.id.trim());
      const resolvedId = !raw.id.trim() || idTaken ? String(nextManualId(cameras)) : raw.id.trim();
      commitManualCameras([...manualCameras, { ...raw, id: resolvedId }]);
    },
    [cameras, manualCameras, commitManualCameras]
  );

  const importCameras = useCallback(
    (raws: OrganizerCamera[]) => {
      const takenIds = new Set(cameras.map((c) => String(c.id)));
      let pool = cameras;
      const resolved: OrganizerCamera[] = [];
      raws.forEach((raw) => {
        let id = raw.id.trim();
        if (!id || takenIds.has(id)) {
          const freshId = nextManualId(pool);
          id = String(freshId);
          pool = [...pool, { id: freshId } as Camera];
        }
        takenIds.add(id);
        resolved.push({ ...raw, id });
      });
      commitManualCameras([...manualCameras, ...resolved]);
    },
    [cameras, manualCameras, commitManualCameras]
  );

  // Deliberate: this is the initial registry fetch on mount — refreshCameras
  // sets isLoading/cameras/error as the network call resolves, which is
  // exactly what an effect is for (synchronizing with an external system).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    if (isScaleRoute) return;
    refreshCameras();
  }, [refreshCameras, isScaleRoute]);

  const filteredCameras = useMemo(() => {
    return cameras.filter((cam) => {
      // 1. Department filter (handles case-insensitive match & 'All Departments')
      const matchesDept =
        !filters.department ||
        filters.department === 'All Departments' ||
        cam.dept?.toLowerCase() === filters.department.toLowerCase();

      // 2. Connectivity filter (online / offline / all)
      const matchesConnectivity =
        !filters.connectivity ||
        filters.connectivity === 'all' ||
        cam.connectivity_status?.toLowerCase() === filters.connectivity.toLowerCase();

      // 3. Health filter (operational / degraded / fault / all)
      const matchesHealth =
        !filters.health ||
        filters.health === 'all' ||
        (cam.health_status && cam.health_status.toLowerCase() === filters.health.toLowerCase());

      // 4. Search query filter (matches name, location, or camera ID)
      const query = filters.searchQuery?.trim().toLowerCase() || '';
      const matchesSearch =
        !query ||
        cam.name?.toLowerCase().includes(query) ||
        cam.dept?.toLowerCase().includes(query) ||
        String(cam.id).toLowerCase().includes(query);

      return matchesDept && matchesConnectivity && matchesHealth && matchesSearch;
    });
  }, [cameras, filters]);

  // The organizer's width>0 flag is only a preliminary signal (see
  // lib/organizerCameras.ts). Once a camera's live feed actually connects or
  // fails, LiveFeedPlayer reports the real outcome here so the map pin
  // reflects reality instead of staying stuck on the preliminary guess.
  const updateCameraConnectivity = useCallback((id: number, status: ConnectivityStatus) => {
    setCameras((prev) => {
      const idx = prev.findIndex((c) => c.id === id);
      if (idx === -1 || prev[idx].connectivity_status === status) return prev;
      // Fire-and-forget: the backend's own dedup is the real safety net
      // if this fires more than once for the same transition; a failed
      // report here shouldn't block the UI from updating.
      fetch(`${process.env.NEXT_PUBLIC_REGISTRY_API_URL || 'http://localhost:8000'}/cameras/${id}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ connectivity_status: status }),
      }).catch(() => {});
      const next = prev.slice();
      next[idx] = { ...prev[idx], connectivity_status: status };
      return next;
    });
    setSelectedCamera((prev) =>
      prev && prev.id === id && prev.connectivity_status !== status ? { ...prev, connectivity_status: status } : prev
    );
  }, []);

  // Real-time online/offline for every camera — list, badges, and map pins
  // all read connectivity_status off shared state, so this one poller is
  // what keeps all of them current instead of only whichever camera an
  // officer has the drawer open on. A ref (not `cameras` in the deps array)
  // keeps this interval from being torn down and restarted every time a
  // probe result changes state, which would otherwise happen every tick.
  const camerasRef = useRef<Camera[]>(cameras);
  useEffect(() => {
    camerasRef.current = cameras;
  }, [cameras]);

  useEffect(() => {
    if (isScaleRoute) return;
    let cancelled = false;

    const webrtcBase = process.env.NEXT_PUBLIC_MEDIAMTX_WEBRTC_URL;

    const checkAll = async () => {
      const snapshot = camerasRef.current;
      await Promise.allSettled(
        snapshot.map(async (cam) => {
          // Same transport priority as CameraLivePlayer (WebRTC first, HLS
          // fallback) -- previously this always checked HLS only, so a
          // camera playing fine over WebRTC (e.g. Tailscale-only, no
          // Cloudflare tunnel for HLS) still got flipped to "offline" by
          // this poller every 20s.
          const whepUrl = getWebRtcWhepUrl(cam, webrtcBase);
          const stream = getCameraStreamUrl(cam);
          // No stream_id/hls_url provisioned at all means there is nothing that could
          // ever be live -- report offline instead of leaving the registry's possibly
          // stale/manually-set connectivity_status in place forever (this poller
          // otherwise never touches these cameras again).
          if (!whepUrl && !stream.url) {
            if (!cancelled) updateCameraConnectivity(cam.id, 'offline');
            return;
          }

          const reachable = whepUrl
            ? (await probeWebRtcReachable(whepUrl)) || (stream.url ? await probeStreamReachable(stream.url) : false)
            : await probeStreamReachable(stream.url!);

          if (!cancelled) updateCameraConnectivity(cam.id, reachable ? 'online' : 'offline');
        })
      );
      if (!cancelled) setLastUpdated(new Date());
    };

    checkAll();
    const interval = setInterval(checkAll, HEALTH_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [updateCameraConnectivity, isScaleRoute]);

  return (
    <CameraRegistryContext.Provider
      value={{
        cameras,
        filteredCameras,
        selectedCamera,
        filters,
        isLoading,
        error,
        lastUpdated,
        setSelectedCamera,
        setFilters,
        refreshCameras,
        updateCameraConnectivity,
        addCamera,
        importCameras,
      }}
    >
      {children}
    </CameraRegistryContext.Provider>
  );
}

export function useCameraRegistry() {
  const context = useContext(CameraRegistryContext);
  if (!context) throw new Error('useCameraRegistry must be used within CameraRegistryProvider');
  return context;
}