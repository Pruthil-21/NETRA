'use client';

import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import { Camera } from '@/types/camera';
import { CameraFilters } from '@/types/filters';
import { cameraService } from '@/services/cameraService';

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
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);
  const [filters, setFilters] = useState<CameraFilters>(initialFilters);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshCameras = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await cameraService.getAll();
      setCameras(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load camera registry');
    } finally {
      setIsLoading(false);
    }
  }, []);

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