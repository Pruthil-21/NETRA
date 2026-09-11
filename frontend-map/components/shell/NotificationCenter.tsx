'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, MapPin } from 'lucide-react';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { useGeolocation } from '@/lib/geolocation';
import { findNearestCamera } from '@/lib/distance';
import { getCameraCity } from '@/lib/cameraCity';
import { alertsService } from '@/services/alertsService';
import { adminService, NotificationOut } from '@/services/adminService';
import { Alert } from '@/types/alert';

const ALERTS_POLL_INTERVAL_MS = 5000;
const NOTIFICATIONS_POLL_INTERVAL_MS = 15000;

type Tab = 'alerts' | 'notifications';

/** One bell in the header, not two -- AlertsBell (watchlist matches near the
 * officer's own location) and NotificationsBell (account/RBAC events) used
 * to sit side by side as two near-identical bell icons with no visual cue
 * for which was which. Same two data sources, same behavior, just one
 * button and one dropdown with a tab switcher instead of two lookalike
 * icons competing for attention. */
export function NotificationCenter() {
  const router = useRouter();
  const { cameras } = useCameraRegistry();
  const geo = useGeolocation();

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<NotificationOut[]>([]);

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('alerts');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await alertsService.list();
        if (!cancelled) {
          setAlerts(data);
          setAlertsError(null);
        }
      } catch (err) {
        if (!cancelled) setAlertsError(err instanceof Error ? err.message : 'Failed to load alerts');
      }
    };
    poll();
    const interval = setInterval(poll, ALERTS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      adminService
        .listNotifications()
        .then((data) => {
          if (!cancelled) setNotifications(data);
        })
        .catch(() => {
          // Non-fatal: the tab just shows nothing until the next poll succeeds.
        });
    };
    poll();
    const interval = setInterval(poll, NOTIFICATIONS_POLL_INTERVAL_MS);
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

  const unreadCount = notifications.filter((n) => !n.read).length;
  const totalCount = nearbyAlerts.length + unreadCount;

  const handleMarkRead = async (id: number) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    try {
      await adminService.markNotificationRead(id);
    } catch {
      // Non-fatal: the next poll will correct any drift.
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-label="Alerts and notifications"
        onClick={() => setOpen((v) => !v)}
        className="relative p-1.5 text-slate-400 hover:text-white bg-panel-raised rounded border border-line"
      >
        <Bell size={14} />
        {totalCount > 0 && (
          <span
            className={`absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full text-white text-[10px] font-bold flex items-center justify-center ${
              nearbyAlerts.length > 0 ? 'bg-signal-red' : 'bg-command'
            }`}
          >
            {totalCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-panel border border-line rounded shadow-xl z-[2000] text-xs">
          <div role="tablist" className="flex border-b border-line">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'alerts'}
              onClick={() => setTab('alerts')}
              className={`flex-1 px-3 py-2 text-center font-semibold ${
                tab === 'alerts' ? 'text-white border-b-2 border-signal-red -mb-px' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              Alerts{nearbyAlerts.length > 0 ? ` (${nearbyAlerts.length})` : ''}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'notifications'}
              onClick={() => setTab('notifications')}
              className={`flex-1 px-3 py-2 text-center font-semibold ${
                tab === 'notifications' ? 'text-white border-b-2 border-command -mb-px' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              Notifications{unreadCount > 0 ? ` (${unreadCount})` : ''}
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {tab === 'alerts' ? (
              <>
                <div className="px-3 py-2 border-b border-line flex items-center gap-1.5 text-slate-400">
                  <MapPin size={12} />
                  {geo.status === 'loading' && <span>Detecting your location…</span>}
                  {geo.status === 'error' && <span>Location unavailable — {geo.message}</span>}
                  {geo.status === 'ready' && <span>Nearby alerts{currentCity ? ` — ${currentCity}` : ''}</span>}
                </div>

                {alertsError && <div className="px-3 py-2 text-signal-red">{alertsError}</div>}

                {!alertsError && geo.status === 'ready' && nearbyAlerts.length === 0 && (
                  <div className="px-3 py-3 text-slate-500">No alerts near your current location.</div>
                )}

                {nearbyAlerts.map((a) => {
                  const camera = camerasById.get(a.camera_id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        router.push(`/alerts/track/${encodeURIComponent(a.plate_number)}`);
                      }}
                      className="w-full text-left px-3 py-2 border-b border-line last:border-0 hover:bg-panel-raised"
                    >
                      <p className="font-mono font-semibold text-white">{a.plate_number}</p>
                      <p className="text-slate-400">{camera?.name || `Camera #${a.camera_id}`}</p>
                      {a.nearest_station && (
                        <p className="text-slate-500">
                          Nearest station: {a.nearest_station.name} (
                          {a.nearest_station.distance_meters >= 1000
                            ? `${(a.nearest_station.distance_meters / 1000).toFixed(1)}km`
                            : `${Math.round(a.nearest_station.distance_meters)}m`}
                          )
                        </p>
                      )}
                      <p className="text-slate-600">{new Date(a.matched_at).toLocaleString()}</p>
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
              </>
            ) : (
              <>
                {notifications.length === 0 && <div className="px-3 py-3 text-slate-500">Nothing yet.</div>}
                {notifications.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => handleMarkRead(n.id)}
                    className={`w-full text-left px-3 py-2 border-b border-line last:border-0 hover:bg-panel-raised ${
                      n.read ? 'opacity-60' : ''
                    }`}
                  >
                    <p className="text-white">{n.message}</p>
                    <p className="text-slate-600 mt-0.5">{new Date(n.created_at).toLocaleString()}</p>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default NotificationCenter;
