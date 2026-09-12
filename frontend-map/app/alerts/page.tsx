'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight, Plus, Navigation, Search, Check, ArrowUpCircle, X, ShieldAlert, History } from 'lucide-react';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { alertsService } from '@/services/alertsService';
import { useAlertsStream } from '@/hooks/useAlertsStream';
import { Alert, AlertHistoryEntry, AlertStatus } from '@/types/alert';
import { AddToWatchlistModal } from '@/components/alerts/AddToWatchlistModal';
import { TrafficAlertsSection } from '@/components/alerts/TrafficAlertsSection';
import { getCameraCity } from '@/lib/cameraCity';
import { usePermissions } from '@/hooks/usePermissions';

const POLL_INTERVAL_MS = 5000;

// Turns a raw audit_logs action string into a plain-English sentence for the
// history strip -- mirrors AuditLogSection.tsx's ACTION_DESCRIPTIONS map,
// just scoped to the handful of actions that ever land on an alert.
const HISTORY_ACTION_LABELS: Record<string, string> = {
  create: 'Alert generated',
  alert_acknowledged: 'Acknowledged',
  alert_escalated: 'Escalated',
  alert_dismissed: 'Dismissed',
};
function describeHistoryAction(action: string): string {
  return HISTORY_ACTION_LABELS[action] ?? action;
}

const STATUS_STYLES: Record<string, string> = {
  NEW: 'bg-signal-red/20 text-signal-red border-signal-red/40',
  ACKNOWLEDGED: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
  ESCALATED: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
  DISMISSED: 'bg-slate-700/40 text-slate-400 border-slate-600/40',
};

function timeAgo(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function AlertsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The registry tree's right-click "View Alerts for this Camera" lands
  // here as ?camera=<id> -- narrows both tabs to that one camera instead of
  // an officer having to hunt for it through the city/district groupings.
  const cameraFilterId = useMemo(() => {
    const raw = searchParams.get('camera');
    return raw ? Number(raw) : null;
  }, [searchParams]);
  const { cameras } = useCameraRegistry();
  const { scopeType, scopeValue: homeDistrict, permissions } = usePermissions();
  const canViewTraffic = permissions.includes('view_analytics');
  const [tab, setTab] = useState<'plate' | 'traffic'>('plate');
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedCities, setExpandedCities] = useState<Set<string>>(new Set());
  const [showAddModal, setShowAddModal] = useState(false);
  const [citySearch, setCitySearch] = useState('');
  const [updatingIds, setUpdatingIds] = useState<Set<number>>(new Set());
  const [selectedAlertId, setSelectedAlertId] = useState<number | null>(null);
  const [history, setHistory] = useState<AlertHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  // Dismiss is the one action here that reads as final (Acknowledge/Escalate
  // leave the alert open to further action), and the backend requires a
  // reason_code when dismissing -- this holds the inline reason form's state
  // while it's open for a given alert.
  const [dismissingAlertId, setDismissingAlertId] = useState<number | null>(null);
  const [dismissReason, setDismissReason] = useState('');
  const [dismissError, setDismissError] = useState<string | null>(null);

  const handleUpdateStatus = async (alertId: number, status: AlertStatus, reasonCode?: string) => {
    const previous = alerts;
    setUpdatingIds((prev) => new Set(prev).add(alertId));
    // Optimistic: the officer's click should feel immediate, not wait on a
    // round trip -- reverted below if the PATCH actually fails.
    setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, status } : a)));
    try {
      await alertsService.updateStatus(alertId, status, reasonCode);
      if (alertId === selectedAlertId) {
        alertsService.history(alertId).then(setHistory).catch(() => undefined);
      }
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

  const requestDismiss = (alertId: number) => {
    setDismissingAlertId(alertId);
    setDismissReason('');
    setDismissError(null);
  };

  const cancelDismiss = () => {
    setDismissingAlertId(null);
    setDismissReason('');
    setDismissError(null);
  };

  const confirmDismiss = async () => {
    if (dismissingAlertId == null) return;
    const reason = dismissReason.trim();
    if (!reason) {
      setDismissError('A reason is required to dismiss an alert.');
      return;
    }
    await handleUpdateStatus(dismissingAlertId, 'DISMISSED', reason);
    cancelDismiss();
  };

  const camerasById = useMemo(() => new Map(cameras.map((c) => [c.id, c])), [cameras]);
  const cameraFilterName = cameraFilterId != null
    ? camerasById.get(cameraFilterId)?.name ?? `Camera #${cameraFilterId}`
    : null;

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
    const source = cameraFilterId == null ? alerts : alerts.filter((a) => a.camera_id === cameraFilterId);
    for (const alert of source) {
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
      .sort((a, b) => {
        // The officer's own posting city floats to the top regardless of
        // alphabetical order -- an officer posted to Ahmedabad shouldn't
        // have to scroll past every other city to see alerts from home.
        if (homeDistrict) {
          const aIsHome = a.city.toLowerCase() === homeDistrict.toLowerCase();
          const bIsHome = b.city.toLowerCase() === homeDistrict.toLowerCase();
          if (aIsHome && !bIsHome) return -1;
          if (bIsHome && !aIsHome) return 1;
        }
        return a.city.localeCompare(b.city);
      });
  }, [alerts, camerasById, homeDistrict]);

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

  const selectedAlert = useMemo(
    () => (selectedAlertId != null ? alerts.find((a) => a.id === selectedAlertId) ?? null : null),
    [alerts, selectedAlertId]
  );
  const selectedCamera = selectedAlert ? camerasById.get(selectedAlert.camera_id) : null;

  const selectAlert = (alert: Alert) => {
    setSelectedAlertId(alert.id);
    cancelDismiss();
    const city = camerasById.get(alert.camera_id) ? getCameraCity(camerasById.get(alert.camera_id)!) : 'Unknown location';
    setExpandedCities((prev) => new Set(prev).add(city));
  };

  useEffect(() => {
    if (selectedAlertId == null) {
      setHistory([]);
      return;
    }
    setHistoryLoading(true);
    alertsService
      .history(selectedAlertId)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [selectedAlertId]);

  return (
    <main className="flex-1 flex flex-col overflow-hidden min-h-0 w-full">
      <div className="px-4 sm:px-6 pt-4 pb-3 border-b border-line bg-panel shrink-0">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-sm font-semibold text-white uppercase tracking-wide">Alerts</h1>
          {tab === 'plate' && (
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-slate-300 hover:text-white bg-panel-raised rounded border border-line text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
            >
              <Plus size={13} />
              Add to Blacklist
            </button>
          )}
        </div>

        {canViewTraffic && (
          <div className="flex items-center gap-1.5 mt-3">
            {(['plate', 'traffic'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 rounded text-xs font-semibold transition ${
                  tab === t ? 'bg-command text-white' : 'text-slate-400 hover:text-white hover:bg-panel-raised'
                }`}
              >
                {t === 'plate' ? 'Plate Alerts' : 'Traffic'}
              </button>
            ))}
          </div>
        )}

        {cameraFilterName && (
          <div className="flex items-center gap-2 mt-3 px-2.5 py-1.5 rounded bg-command/10 border border-command/30 text-[11px] text-command w-fit">
            <ShieldAlert size={12} />
            Filtered to <span className="font-semibold">{cameraFilterName}</span>
            <button
              type="button"
              onClick={() => router.push('/alerts')}
              className="ml-1 text-slate-400 hover:text-white"
              aria-label="Clear camera filter"
            >
              <X size={12} />
            </button>
          </div>
        )}

        {/* The backend now only ever returns alerts this officer's postings
            are in scope for (detected in their district, or flagged by it --
            see backend-watchlist's dual-criteria alert rule). Nothing here
            filters the list client-side; this is purely so a district-scoped
            officer understands why the list is narrower than a platform
            view, rather than assuming something's broken. */}
        {scopeType === 'district' && homeDistrict && (
          <p className="mt-2 text-[10px] text-slate-500">
            Scoped to <span className="font-semibold text-slate-400">{homeDistrict}</span> — alerts detected in or
            flagged by your district.
          </p>
        )}
      </div>

      {tab === 'traffic' && canViewTraffic ? (
        <div className="flex-1 flex min-h-0 overflow-hidden">
          <TrafficAlertsSection cameraId={cameraFilterId} />
        </div>
      ) : (
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Left: master list, grouped by city */}
          <div className="w-full sm:w-96 shrink-0 border-r border-line bg-panel flex flex-col min-h-0">
            <div className="p-2.5 border-b border-line">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  value={citySearch}
                  onChange={(e) => setCitySearch(e.target.value)}
                  placeholder="Search city…"
                  className="w-full bg-ink border border-line rounded-md pl-8 pr-2.5 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-command"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {error && <p className="text-signal-red text-xs px-3 py-2">{error}</p>}
              {!error && groupedByCity.length === 0 && (
                <p className="text-slate-500 text-xs p-3">
                  {cameraFilterName
                    ? `No alerts for ${cameraFilterName} yet.`
                    : 'No alerts yet — they appear here the moment a blacklisted plate is detected.'}
                </p>
              )}
              {groupedByCity.length > 0 && visibleGroups.length === 0 && (
                <p className="text-slate-500 text-xs p-3">No cities match &quot;{citySearch}&quot;.</p>
              )}

              {visibleGroups.map(({ city, alerts: cityAlerts }) => {
                const expanded = expandedCities.has(city);
                return (
                  <div key={city} className="border-b border-line last:border-0">
                    <button
                      type="button"
                      onClick={() => toggleCity(city)}
                      className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-panel-raised text-left"
                    >
                      <span className="flex items-center gap-2 text-xs font-semibold text-white">
                        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        {city}
                      </span>
                      <span className="text-[11px] text-slate-400">{cityAlerts.length}</span>
                    </button>

                    {expanded &&
                      cityAlerts.map((alert) => (
                        <button
                          key={alert.id}
                          type="button"
                          onClick={() => selectAlert(alert)}
                          className={`w-full text-left flex items-start gap-2 pl-7 pr-3 py-2 border-l-2 transition-colors ${
                            selectedAlertId === alert.id
                              ? 'bg-command/10 border-l-command'
                              : 'border-l-transparent hover:bg-panel-raised'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-mono text-xs font-semibold text-white truncate">{alert.plate_number}</p>
                            <p className="text-[11px] text-slate-500 truncate">
                              {camerasById.get(alert.camera_id)?.name || `Camera #${alert.camera_id}`}
                            </p>
                          </div>
                          <div className="shrink-0 flex flex-col items-end gap-1">
                            <span className={`px-1.5 py-0.5 rounded border text-[9px] font-semibold ${STATUS_STYLES[alert.status] || STATUS_STYLES.DISMISSED}`}>
                              {alert.status}
                            </span>
                            <span className="text-[10px] text-slate-600">{timeAgo(alert.matched_at)}</span>
                          </div>
                        </button>
                      ))}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: detail + actions for the selected alert */}
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {!selectedAlert ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 text-slate-600">
                <ShieldAlert size={28} />
                <p className="text-sm text-slate-500">Select an alert to view details and take action</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-6">
                <div className="max-w-3xl">
                  {/* Identity row */}
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <p className="font-mono text-2xl font-bold text-white">{selectedAlert.plate_number}</p>
                      <p className="text-xs text-slate-500 mt-1">
                        {selectedCamera?.name || `Camera #${selectedAlert.camera_id}`} &middot;{' '}
                        {new Date(selectedAlert.matched_at).toLocaleString()}
                      </p>
                    </div>
                    <span
                      className={`px-2.5 py-1 rounded-full border text-[11px] font-semibold shrink-0 ${
                        STATUS_STYLES[selectedAlert.status] || STATUS_STYLES.DISMISSED
                      }`}
                    >
                      {selectedAlert.status}
                    </span>
                  </div>

                  {/* Actions row -- always labeled, mirrors the Users admin
                      section's action-row convention rather than icon-only
                      buttons crammed into a list row. */}
                  <div className="flex items-center gap-2 flex-wrap mt-4">
                    {(selectedAlert.status === 'NEW' || selectedAlert.status === 'ACKNOWLEDGED') && (
                      <>
                        {selectedAlert.status !== 'ACKNOWLEDGED' && (
                          <button
                            type="button"
                            onClick={() => handleUpdateStatus(selectedAlert.id, 'ACKNOWLEDGED')}
                            disabled={updatingIds.has(selectedAlert.id)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-line bg-panel-raised text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-50 disabled:cursor-wait transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                          >
                            <Check size={13} />
                            Acknowledge
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleUpdateStatus(selectedAlert.id, 'ESCALATED')}
                          disabled={updatingIds.has(selectedAlert.id)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-line bg-panel-raised text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-50 disabled:cursor-wait transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                        >
                          <ArrowUpCircle size={13} />
                          Escalate
                        </button>
                        <button
                          type="button"
                          onClick={() => requestDismiss(selectedAlert.id)}
                          disabled={updatingIds.has(selectedAlert.id)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-line bg-panel-raised text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-50 disabled:cursor-wait transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                        >
                          <X size={13} />
                          Dismiss
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => router.push(`/alerts/track/${encodeURIComponent(selectedAlert.plate_number)}`)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-line bg-panel-raised text-slate-300 hover:text-white hover:border-slate-500 transition-colors"
                    >
                      <Navigation size={13} />
                      Track vehicle
                    </button>
                  </div>

                  {dismissingAlertId === selectedAlert.id && (
                    <div className="mt-3 p-3.5 border border-signal-red/40 bg-signal-red/5 rounded-lg max-w-md">
                      <label htmlFor="dismiss-reason" className="block text-[11px] font-semibold text-signal-red uppercase tracking-wide mb-1.5">
                        Reason for dismissal (required)
                      </label>
                      <input
                        id="dismiss-reason"
                        value={dismissReason}
                        onChange={(e) => {
                          setDismissReason(e.target.value);
                          setDismissError(null);
                        }}
                        placeholder="e.g. false plate match, vehicle already recovered"
                        autoFocus
                        className="w-full bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-command mb-2"
                      />
                      {dismissError && <p className="text-[11px] text-signal-red mb-2">{dismissError}</p>}
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={cancelDismiss} className="px-2.5 py-1.5 text-xs font-medium text-slate-400 hover:text-white">
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={updatingIds.has(selectedAlert.id)}
                          onClick={confirmDismiss}
                          className="px-2.5 py-1.5 text-xs font-semibold bg-signal-red hover:bg-signal-red/80 text-white rounded disabled:opacity-50 disabled:cursor-wait"
                        >
                          Confirm Dismiss
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Detail cards -- location/timing on the left, owner +
                      case lookup on the right once real access exists
                      server-side; until then the lookup card just doesn't
                      render rather than showing an empty placeholder. */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-6">
                    <div className="border border-line rounded-lg bg-panel">
                      <div className="px-4 py-3 border-b border-line text-xs font-semibold text-slate-300">Location</div>
                      {[
                        ['Camera', selectedCamera?.name || `Camera #${selectedAlert.camera_id}`],
                        ['District', selectedCamera?.dept ?? '—'],
                        [
                          'Nearest station',
                          selectedAlert.nearest_station
                            ? `${selectedAlert.nearest_station.name} (${
                                selectedAlert.nearest_station.distance_meters >= 1000
                                  ? `${(selectedAlert.nearest_station.distance_meters / 1000).toFixed(1)}km`
                                  : `${Math.round(selectedAlert.nearest_station.distance_meters)}m`
                              })`
                            : '—',
                        ],
                        ['Matched at', new Date(selectedAlert.matched_at).toLocaleString()],
                      ].map(([label, value]) => (
                        <div key={label} className="grid grid-cols-[140px_1fr] px-4 py-2.5 border-b border-line last:border-0 items-center">
                          <span className="text-[11px] font-semibold text-slate-500">{label}</span>
                          <span className="text-xs text-white">{value}</span>
                        </div>
                      ))}
                    </div>

                    {(selectedAlert.owner_details?.vahan.status === 'ok' ||
                      selectedAlert.owner_details?.egujcop.status === 'ok') && (
                      <div className="border border-line rounded-lg bg-panel h-fit">
                        <div className="px-4 py-3 border-b border-line text-xs font-semibold text-slate-300">Owner &amp; Case Lookup</div>
                        {selectedAlert.owner_details?.vahan.status === 'ok' && (
                          <div className="grid grid-cols-[140px_1fr] px-4 py-2.5 border-b border-line items-center">
                            <span className="text-[11px] font-semibold text-slate-500">Owner</span>
                            <span className="text-xs text-white">{selectedAlert.owner_details.vahan.owner_name || 'Unknown'}</span>
                          </div>
                        )}
                        {selectedAlert.owner_details?.egujcop.status === 'ok' && selectedAlert.owner_details.egujcop.has_open_case && (
                          <div className="grid grid-cols-[140px_1fr] px-4 py-2.5 items-center">
                            <span className="text-[11px] font-semibold text-slate-500">Open case</span>
                            <span className="text-xs text-amber-400">{selectedAlert.owner_details.egujcop.case_ids?.join(', ') || 'yes'}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Activity history -- who acknowledged/escalated/dismissed
                      this alert and when, sourced from the same audit_logs
                      rows the Admin > Audit Log page reads (see
                      audit_service.history_for) so an officer doesn't have
                      to leave this page to see accountability for one alert. */}
                  <div className="border border-line rounded-lg bg-panel mt-4">
                    <div className="px-4 py-3 border-b border-line flex items-center gap-2 text-xs font-semibold text-slate-300">
                      <History size={13} />
                      Activity History
                    </div>
                    <div className="px-4 py-3">
                      {historyLoading ? (
                        <p className="text-xs text-slate-500">Loading…</p>
                      ) : history.length === 0 ? (
                        <p className="text-xs text-slate-500 italic">No recorded activity yet.</p>
                      ) : (
                        <div className="flex flex-col gap-3">
                          {history.map((entry, i) => (
                            <div key={i} className="flex items-start gap-2.5">
                              <span className="mt-1 w-1.5 h-1.5 rounded-full bg-command shrink-0" />
                              <div className="min-w-0">
                                <p className="text-xs text-white">
                                  {describeHistoryAction(entry.action)}
                                  {entry.badge_number && (
                                    <>
                                      {' '}
                                      by <span className="font-mono">{entry.badge_number}</span>
                                    </>
                                  )}
                                </p>
                                <p className="text-[11px] text-slate-500">
                                  {new Date(entry.timestamp).toLocaleString()}
                                  {entry.reason_code ? ` — ${entry.reason_code}` : ''}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showAddModal && (
        <AddToWatchlistModal onClose={() => setShowAddModal(false)} onAdded={() => setShowAddModal(false)} />
      )}
    </main>
  );
}
