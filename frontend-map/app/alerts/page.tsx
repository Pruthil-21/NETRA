'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, Plus, Navigation, Search, Check, ArrowUpCircle, X } from 'lucide-react';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { alertsService } from '@/services/alertsService';
import { useAlertsStream } from '@/hooks/useAlertsStream';
import { Alert, AlertStatus } from '@/types/alert';
import { AddToWatchlistModal } from '@/components/alerts/AddToWatchlistModal';
import { getCameraCity } from '@/lib/cameraCity';

// Every alert starts NEW and needs an officer to act on it -- these are the
// only forward transitions the backend accepts (append-only history, see
// alertsService.updateStatus); there's no path back to NEW.
const ACTIONS: { status: AlertStatus; label: string; icon: typeof Check }[] = [
  { status: 'ACKNOWLEDGED', label: 'Acknowledge', icon: Check },
  { status: 'ESCALATED', label: 'Escalate', icon: ArrowUpCircle },
  { status: 'DISMISSED', label: 'Dismiss', icon: X },
];

const POLL_INTERVAL_MS = 5000;

const STATUS_STYLES: Record<string, string> = {
  NEW: 'bg-signal-red/20 text-signal-red border-signal-red/40',
  ACKNOWLEDGED: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
  ESCALATED: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
  DISMISSED: 'bg-slate-700/40 text-slate-400 border-slate-600/40',
};

export default function AlertsPage() {
  const router = useRouter();
  const { cameras } = useCameraRegistry();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedCities, setExpandedCities] = useState<Set<string>>(new Set());
  const [showAddModal, setShowAddModal] = useState(false);
  const [citySearch, setCitySearch] = useState('');
  const [updatingIds, setUpdatingIds] = useState<Set<number>>(new Set());
  // Dismiss is the one action here that reads as final (Acknowledge/Escalate leave the
  // alert open to further action) -- these ids are mid-confirm, waiting on a second click.
  const [confirmDismissIds, setConfirmDismissIds] = useState<Set<number>>(new Set());

  const handleUpdateStatus = async (alertId: number, status: AlertStatus) => {
    const previous = alerts;
    setUpdatingIds((prev) => new Set(prev).add(alertId));
    // Optimistic: the officer's click should feel immediate, not wait on a
    // round trip -- reverted below if the PATCH actually fails.
    setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, status } : a)));
    try {
      await alertsService.updateStatus(alertId, status);
    } catch (err) {
      setAlerts(previous);
      setError(err instanceof Error ? err.message : 'Failed to update alert');
    } finally {
      setUpdatingIds((prev) => {
        const next = new Set(prev);
        next.delete(alertId);
        return next;
      });
    }
  };

  // First click arms the confirm state (auto-reverts after 4s if not followed
  // up); second click while armed actually fires the dismiss.
  const requestDismiss = (alertId: number) => {
    if (confirmDismissIds.has(alertId)) {
      setConfirmDismissIds((prev) => {
        const next = new Set(prev);
        next.delete(alertId);
        return next;
      });
      handleUpdateStatus(alertId, 'DISMISSED');
      return;
    }
    setConfirmDismissIds((prev) => new Set(prev).add(alertId));
    setTimeout(() => {
      setConfirmDismissIds((prev) => {
        const next = new Set(prev);
        next.delete(alertId);
        return next;
      });
    }, 4000);
  };

  const camerasById = useMemo(() => new Map(cameras.map((c) => [c.id, c])), [cameras]);

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

  // Live push on top of the poll above -- the poll stays as the safety net for
  // anything missed during a reconnect window, this just closes the gap between
  // an alert firing and the next 5s tick.
  useAlertsStream((newAlert) => {
    setAlerts((prev) => {
      const alert = newAlert as Alert;
      if (prev.some((a) => a.id === alert.id)) return prev;
      return [alert, ...prev];
    });
  });

  // Grouped by real city (getCameraCity), not the raw camera.dept field --
  // for organizer cameras dept is a landmark/locality label ("04 Paldi
  // Circle"), too granular for a city-level view like "Ahmedabad".
  const groupedByCity = useMemo(() => {
    const groups = new Map<string, Alert[]>();
    for (const alert of alerts) {
      const camera = camerasById.get(alert.camera_id);
      const city = camera ? getCameraCity(camera) : 'Unknown location';
      if (!groups.has(city)) groups.set(city, []);
      groups.get(city)!.push(alert);
    }
    return Array.from(groups.entries())
      .map(([city, cityAlerts]) => ({
        city,
        alerts: [...cityAlerts].sort((a, b) => new Date(b.matched_at).getTime() - new Date(a.matched_at).getTime()),
      }))
      .sort((a, b) => a.city.localeCompare(b.city));
  }, [alerts, camerasById]);

  const visibleGroups = useMemo(() => {
    const query = citySearch.trim().toLowerCase();
    if (!query) return groupedByCity;
    return groupedByCity.filter(({ city }) => city.toLowerCase().includes(query));
  }, [groupedByCity, citySearch]);

  const toggleCity = (city: string) => {
    setExpandedCities((prev) => {
      const next = new Set(prev);
      if (next.has(city)) next.delete(city);
      else next.add(city);
      return next;
    });
  };

  return (
    <main className="flex-1 overflow-y-auto p-4 sm:p-6 min-h-0 w-full">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-sm font-semibold text-white uppercase tracking-wide">Alerts</h1>
        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-slate-300 hover:text-white bg-panel-raised rounded border border-line text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
        >
          <Plus size={13} />
          Add to Blacklist
        </button>
      </div>

      <div>
        {error && <p className="text-signal-red text-xs mb-3">{error}</p>}
        {!error && alerts.length === 0 && (
          <p className="text-slate-500 text-xs">No alerts yet — they appear here the moment a blacklisted plate is detected.</p>
        )}

        {alerts.length > 0 && (
          <div className="relative max-w-2xl mb-3">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={citySearch}
              onChange={(e) => setCitySearch(e.target.value)}
              placeholder="Search city…"
              className="w-full bg-panel border border-line rounded pl-8 pr-3 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-command"
            />
          </div>
        )}

        {alerts.length > 0 && visibleGroups.length === 0 && (
          <p className="text-slate-500 text-xs">No cities match &quot;{citySearch}&quot;.</p>
        )}

        <div className="flex flex-col gap-2 max-w-2xl">
          {visibleGroups.map(({ city, alerts: cityAlerts }) => {
            const expanded = expandedCities.has(city);
            return (
              <div key={city} className="border border-line rounded overflow-hidden bg-panel">
                <button
                  type="button"
                  onClick={() => toggleCity(city)}
                  className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-panel-raised text-left"
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-white">
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {city}
                  </span>
                  <span className="text-xs text-slate-400">{cityAlerts.length} alert{cityAlerts.length === 1 ? '' : 's'}</span>
                </button>

                {expanded && (
                  <div className="border-t border-line">
                    {cityAlerts.map((alert) => {
                      const camera = camerasById.get(alert.camera_id);
                      return (
                        <div
                          key={alert.id}
                          className="px-3 py-2.5 border-b border-line last:border-0 flex items-center justify-between gap-3 text-xs"
                        >
                          <div className="min-w-0">
                            <p className="font-mono font-semibold text-white">{alert.plate_number}</p>
                            <p className="text-slate-400 truncate">{camera?.name || `Camera #${alert.camera_id}`}</p>
                            {alert.nearest_station && (
                              <p className="text-slate-500 truncate">
                                Nearest station: {alert.nearest_station.name} (
                                {alert.nearest_station.distance_meters >= 1000
                                  ? `${(alert.nearest_station.distance_meters / 1000).toFixed(1)}km`
                                  : `${Math.round(alert.nearest_station.distance_meters)}m`}
                                )
                              </p>
                            )}
                            <p className="text-slate-600">{new Date(alert.matched_at).toLocaleString()}</p>
                            {/* Owner details (VAHAN) / police records (eGujCop) -- only
                                rendered once real access exists server-side (status "ok");
                                until then every alert's status is "not_configured", so this
                                stays hidden rather than repeating a placeholder on every row. */}
                            {alert.owner_details?.vahan.status === 'ok' && (
                              <p className="text-slate-500 truncate">
                                Owner: {alert.owner_details.vahan.owner_name || 'Unknown'}
                              </p>
                            )}
                            {alert.owner_details?.egujcop.status === 'ok' &&
                              alert.owner_details.egujcop.has_open_case && (
                                <p className="text-amber-400 truncate">
                                  Open case: {alert.owner_details.egujcop.case_ids?.join(', ') || 'yes'}
                                </p>
                              )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className={`px-2 py-0.5 rounded border text-[10px] font-semibold ${STATUS_STYLES[alert.status] || STATUS_STYLES.DISMISSED}`}>
                              {alert.status}
                            </span>
                            {(alert.status === 'NEW' || alert.status === 'ACKNOWLEDGED') &&
                              ACTIONS.filter((a) => a.status !== alert.status).map(({ status, label, icon: Icon }) => {
                                const isDismiss = status === 'DISMISSED';
                                const armed = isDismiss && confirmDismissIds.has(alert.id);
                                return (
                                  <button
                                    key={status}
                                    type="button"
                                    onClick={() => (isDismiss ? requestDismiss(alert.id) : handleUpdateStatus(alert.id, status))}
                                    disabled={updatingIds.has(alert.id)}
                                    aria-label={armed ? `Confirm dismiss for ${alert.plate_number}` : `${label} alert for ${alert.plate_number}`}
                                    title={armed ? 'Click again to confirm' : label}
                                    className={`flex items-center gap-1 rounded border disabled:opacity-50 disabled:cursor-wait focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command ${
                                      armed
                                        ? 'px-2 py-1 bg-red-950 border-red-800 text-red-200 ring-1 ring-red-400 animate-pulse'
                                        : 'px-1.5 py-1 bg-panel-raised border-line text-slate-300 hover:text-white'
                                    }`}
                                  >
                                    <Icon size={12} />
                                    {armed && <span className="text-[10px] font-semibold whitespace-nowrap">Confirm?</span>}
                                  </button>
                                );
                              })}
                            <button
                              type="button"
                              onClick={() => router.push(`/alerts/track/${encodeURIComponent(alert.plate_number)}`)}
                              aria-label={`Track ${alert.plate_number}`}
                              className="flex items-center gap-1 px-2 py-1 bg-panel-raised border border-line rounded text-slate-300 hover:text-white"
                            >
                              <Navigation size={12} />
                              Track
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {showAddModal && (
        <AddToWatchlistModal onClose={() => setShowAddModal(false)} onAdded={() => setShowAddModal(false)} />
      )}
    </main>
  );
}
