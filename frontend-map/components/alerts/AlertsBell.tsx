'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, MapPin } from 'lucide-react';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { useGeolocation } from '@/lib/geolocation';
import { findNearestCamera } from '@/lib/distance';
import { getCameraCity } from '@/lib/cameraCity';
import { alertsService } from '@/services/alertsService';
import { Alert } from '@/types/alert';

// Same cadence as the vehicle-search sighting poll (VehicleSearchPanel) --
// alerts should appear without an officer needing to search or refresh.
const POLL_INTERVAL_MS = 5000;

/** Header widget: shows only alerts near the officer's *own* current
 * location (found via the camera nearest to them, since this app has no
 * general reverse-geocoding) -- not every alert app-wide, which lives on
 * the full /alerts page instead. Mount once per page header. */
export function AlertsBell() {
  const router = useRouter();
  const { cameras } = useCameraRegistry();
  const geo = useGeolocation();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await alertsService.list();
        if (!cancelled) {
          setAlerts(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load alerts');
      }
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const camerasById = useMemo(() => new Map(cameras.map((c) => [c.id, c])), [cameras]);

  const currentCity = useMemo(() => {
    if (geo.status !== 'ready' || cameras.length === 0) return null;
    const nearest = findNearestCamera(geo.position, cameras);
    return nearest ? getCameraCity(nearest) : null;
  }, [geo, cameras]);

  const nearbyAlerts = useMemo(() => {
    if (!currentCity) return [];
    return alerts.filter((a) => {
      const camera = camerasById.get(a.camera_id);
      return camera && getCameraCity(camera) === currentCity;
    });
  }, [alerts, camerasById, currentCity]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-label="Nearby alerts"
        onClick={() => setOpen((v) => !v)}
        className="relative p-1.5 text-slate-400 hover:text-white bg-panel-raised rounded border border-line"
      >
        <Bell size={14} />
        {nearbyAlerts.length > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-signal-red text-white text-[10px] font-bold flex items-center justify-center">
            {nearbyAlerts.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto bg-panel border border-line rounded shadow-xl z-[2000] text-xs">
          <div className="px-3 py-2 border-b border-line flex items-center gap-1.5 text-slate-400">
            <MapPin size={12} />
            {geo.status === 'loading' && <span>Detecting your location…</span>}
            {geo.status === 'error' && <span>Location unavailable — {geo.message}</span>}
            {geo.status === 'ready' && (
              <span>Nearby alerts{currentCity ? ` — ${currentCity}` : ''}</span>
            )}
          </div>

          {error && <div className="px-3 py-2 text-signal-red">{error}</div>}

          {!error && geo.status === 'ready' && nearbyAlerts.length === 0 && (
            <div className="px-3 py-3 text-slate-500">No alerts near your current location.</div>
          )}

          {nearbyAlerts.map((alert) => {
            const camera = camerasById.get(alert.camera_id);
            return (
              <button
                key={alert.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  router.push(`/alerts/track/${encodeURIComponent(alert.plate_number)}`);
                }}
                className="w-full text-left px-3 py-2 border-b border-line last:border-0 hover:bg-panel-raised"
              >
                <p className="font-mono font-semibold text-white">{alert.plate_number}</p>
                <p className="text-slate-400">{camera?.name || `Camera #${alert.camera_id}`}</p>
                <p className="text-slate-600">{new Date(alert.matched_at).toLocaleString()}</p>
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              router.push('/alerts');
            }}
            className="w-full text-center px-3 py-2 text-blue-400 hover:bg-panel-raised"
          >
            View all alerts
          </button>
        </div>
      )}
    </div>
  );
}

export default AlertsBell;
