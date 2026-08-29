'use client';

import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Camera, ConnectivityStatus } from '@/types/camera';
import { CameraFilters } from '@/types/filters';
import { OrganizerCamera } from '@/types/organizerCamera';
import { organizerCameraService } from '@/services/organizerCameraService';
import { organizerCameraToCamera } from '@/lib/organizerCameras';
import { TEST_CCTV_CAMERAS } from '@/lib/testCameras';
import { loadManualCameras, saveManualCameras, nextManualId } from '@/lib/manualCameras';
import { getCameraStreamUrl } from '@/lib/stream';

// How often every camera (not just the one an officer has open) gets a real
// reachability check, and how long each check can take before it's counted
// as offline. A plain GET on the manifest/playlist URL — no video decode —
// so checking dozens of cameras in parallel stays cheap.
const HEALTH_CHECK_INTERVAL_MS = 20000;
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

interface RegistryContextType {
  cameras: Camera[];
  filteredCameras: Camera[];
  selectedCamera: Camera | null;
  filters: CameraFilters;
  isLoading: boolean;
  error: string | null;
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
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [manualCameras, setManualCameras] = useState<OrganizerCamera[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);
  const [filters, setFilters] = useState<CameraFilters>(initialFilters);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshCameras = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await organizerCameraService.getAll();
      const manual = loadManualCameras();
      setManualCameras(manual);
      setCameras([...data, ...manual.map(organizerCameraToCamera), ...TEST_CCTV_CAMERAS]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load camera registry');
    } finally {
      setIsLoading(false);
    }
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
      return [...withoutOldManual, ...updatedManual.map(organizerCameraToCamera)];
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

  useEffect(() => {
    refreshCameras();
  }, [refreshCameras]);

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
    setCameras((prev) =>
      prev.map((c) => (c.id === id && c.connectivity_status !== status ? { ...c, connectivity_status: status } : c))
    );
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
    let cancelled = false;

    const checkAll = async () => {
      const snapshot = camerasRef.current;
      await Promise.allSettled(
        snapshot.map(async (cam) => {
          const stream = getCameraStreamUrl(cam);
          if (!stream.url) return;
          const reachable = await probeStreamReachable(stream.url);
          if (!cancelled) updateCameraConnectivity(cam.id, reachable ? 'online' : 'offline');
        })
      );
    };

    checkAll();
    const interval = setInterval(checkAll, HEALTH_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [updateCameraConnectivity]);

  return (
    <CameraRegistryContext.Provider
      value={{
        cameras,
        filteredCameras,
        selectedCamera,
        filters,
        isLoading,
        error,
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