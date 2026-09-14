'use client';

import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { Camera } from '@/types/camera';
import { CameraFilters } from '@/types/filters';
import { OrganizerCamera } from '@/types/organizerCamera';
import { organizerCameraToCamera } from '@/lib/organizerCameras';
import { TEST_CCTV_CAMERAS } from '@/lib/testCameras';
import { VEHICLE_TRACE_DEMO_CAMERAS } from '@/lib/vehicleTraceCameras';
import { loadManualCameras, saveManualCameras, nextManualId } from '@/lib/manualCameras';
import { authHeaders } from '@/lib/apiAuth';
import { SESSION_CHANGED_EVENT } from '@/lib/session';

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

// How often the registry re-fetches GET /cameras so a connectivity_status
// flip made by backend-registry's own periodic sweep (the single
// server-owned health check -- see cameras_service.run_periodic_connectivity_sweep)
// actually reaches this app. Cheap now: a plain DB-backed read, not a
// per-camera reachability probe from every open browser tab (that used to
// run here directly and is exactly what made badges disagree across pages
// and couldn't scale -- see the camera-badge-accuracy fix).
export const HEALTH_CHECK_INTERVAL_MS = 20000;

interface RegistryContextType {
  cameras: Camera[];
  filteredCameras: Camera[];
  selectedCamera: Camera | null;
  filters: CameraFilters;
  isLoading: boolean;
  error: string | null;
  /** When GET /cameras was last successfully re-fetched -- pair with
   * HEALTH_CHECK_INTERVAL_MS to know whether connectivity_status (decided
   * server-side by backend-registry's own periodic sweep) is still fresh. */
  lastUpdated: Date | null;
  setSelectedCamera: (cam: Camera | null) => void;
  setFilters: React.Dispatch<React.SetStateAction<CameraFilters>>;
  refreshCameras: () => Promise<void>;
  /** Adds one manually-entered camera (raw backend shape). Auto-assigns an id
   * in the 8000-8999 range when the given id is blank or already taken. */
  addCamera: (raw: OrganizerCamera) => void;
  /** Bulk-imports many cameras at once (CSV/JSON upload), same id rules as addCamera. */
  importCameras: (raws: OrganizerCamera[]) => void;
  /** Reflects a real registry camera's edited fields in local state after
   * the caller (the right-click Configure/Rename actions) has already
   * confirmed the write succeeded via cameraService.updateCamera, without
   * making the network call itself or waiting on a full refetch -- any
   * subset of fields, so each new editable field doesn't need its own
   * bespoke context method. */
  applyCameraUpdate: (id: number, patch: Partial<Camera>) => void;
  /** Removes a deleted registry camera from local state immediately, rather
   * than waiting for the next refreshCameras() poll -- the caller has
   * already confirmed the DELETE succeeded via cameraService.deleteCamera. */
  removeCamera: (id: number) => void;
}

const initialFilters: CameraFilters = {
  departments: [],
  areaIds: [],
  connectivity: 'all',
  health: 'all',
  searchQuery: '',
  mapLayer: 'none',
  densityMode: 'live',
  densityWindowMinutes: 30,
  densityHour: new Date().getHours(),
  flowMode: 'live',
  flowWindowMinutes: 30,
  flowHour: new Date().getHours(),
  showPoliceStations: true,
};

const CameraRegistryContext = createContext<RegistryContextType | undefined>(undefined);

export function CameraRegistryProvider({ children }: { children: React.ReactNode }) {
  // The scale demo (/scale) is an isolated synthetic-data control plane --
  // its whole point is exercising the registry API at 80,000-row scale in
  // deliberate separation from the real camera fleet. This provider still
  // has to wrap /scale (AppShell's StatusTicker reads `cameras` from this
  // same context for the top-bar chrome shared by every route), but the
  // real-camera fetch and its 20s re-poll are pure overhead there -- and
  // worse, concurrent network traffic that skews the demo's own metrics
  // panel. Gating on pathname is the minimal fix: skip firing them while
  // on /scale, without changing this provider's shape for any other route.
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
    setLastUpdated(new Date());
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

  // Keeps connectivity_status (and everything else about a camera) current
  // without re-probing any stream from the browser -- backend-registry's
  // own periodic sweep is the only thing that ever decides ONLINE/OFFLINE
  // now (see run_periodic_connectivity_sweep); this just re-reads whatever
  // it last decided. Skips /scale for the same reason the old reachability
  // poll did: synthetic demo data, and concurrent traffic here would skew
  // that demo's own metrics panel.
  useEffect(() => {
    if (isScaleRoute) return;
    const interval = setInterval(refreshCameras, HEALTH_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshCameras, isScaleRoute]);

  // This provider mounts once at the app root -- if that first mount
  // happens before anyone has logged in (e.g. landing on /login), the
  // fetch above 401s with no token and never gets a second try, since
  // login() navigates client-side afterward rather than reloading the
  // page. Without this, every camera tree/area shows zero cameras until a
  // hard refresh remounts the provider fresh with the token already in
  // place -- see lib/session.ts's SESSION_CHANGED_EVENT.
  useEffect(() => {
    if (isScaleRoute) return;
    const onSessionChanged = () => refreshCameras();
    window.addEventListener(SESSION_CHANGED_EVENT, onSessionChanged);
    return () => window.removeEventListener(SESSION_CHANGED_EVENT, onSessionChanged);
  }, [refreshCameras, isScaleRoute]);

  const filteredCameras = useMemo(() => {
    return cameras.filter((cam) => {
      // 1. Location filter -- a camera passes if it's in any selected city
      // (department) OR any selected area (area); picking a city and a
      // specific area elsewhere means "either," not "both." No selection at
      // all means every location passes.
      const matchesDept =
        (filters.departments.length === 0 && filters.areaIds.length === 0) ||
        filters.departments.some((d) => cam.dept?.toLowerCase() === d.toLowerCase()) ||
        (cam.area_id != null && filters.areaIds.includes(cam.area_id));

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

  const applyCameraUpdate = useCallback((id: number, patch: Partial<Camera>) => {
    setCameras((prev) => {
      const idx = prev.findIndex((c) => c.id === id);
      if (idx === -1) return prev;
      const next = prev.slice();
      next[idx] = { ...prev[idx], ...patch };
      return next;
    });
    setSelectedCamera((prev) => (prev && prev.id === id ? { ...prev, ...patch } : prev));
  }, []);

  const removeCamera = useCallback((id: number) => {
    setCameras((prev) => prev.filter((c) => c.id !== id));
    setSelectedCamera((prev) => (prev && prev.id === id ? null : prev));
  }, []);

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
        addCamera,
        importCameras,
        applyCameraUpdate,
        removeCamera,
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