'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, X, Gauge, Waypoints, ShieldAlert } from 'lucide-react';
import { usePermissions } from '@/hooks/usePermissions';
import { useAlertsStream } from '@/hooks/useAlertsStream';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { trafficAlertsService, TrafficAlert, TrafficAlertStatus } from '@/services/trafficAlertsService';

interface StreamMessage extends Partial<TrafficAlert> {
  kind?: string;
}

const STATUS_STYLES: Record<TrafficAlertStatus, string> = {
  NEW: 'bg-signal-red/20 text-signal-red border-signal-red/40',
  ACKNOWLEDGED: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
  DISMISSED: 'bg-slate-700/40 text-slate-400 border-slate-600/40',
};

const STATUS_FILTERS: { value: TrafficAlertStatus | 'ALL'; label: string }[] = [
  { value: 'NEW', label: 'New' },
  { value: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { value: 'ALL', label: 'All' },
];

function timeAgo(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** How far past the threshold this reading is -- density breaches trip when
 * the metric rises ABOVE the threshold (too many vehicles), flow breaches
 * trip when it falls BELOW it (too slow); a bare "value vs threshold" pair
 * doesn't tell an officer which direction is bad, so this collapses both
 * into one "Nx over threshold" severity number. */
function severityRatio(alert: TrafficAlert): number {
  if (alert.alert_type === 'density') {
    return alert.threshold_value > 0 ? alert.metric_value / alert.threshold_value : 1;
  }
  return alert.metric_value > 0 ? alert.threshold_value / alert.metric_value : 2;
}

/** The full congestion-alert history + acknowledge/dismiss workflow -- the
 * Map page's TrafficAlertsPanel is a quick-glance subset of exactly this
 * same NEW-status data, same relationship the Data Console's "Just Ran"
 * list has to Audit Log. Master-detail split (list grouped by district,
 * detail + actions on the right) mirrors the plate-alerts tab next door,
 * rather than the flat capped-width list this used to be. */
export function TrafficAlertsSection() {
  const { permissions } = usePermissions();
  const canAcknowledge = permissions.includes('acknowledge_alerts');
  const { cameras } = useCameraRegistry();
  const camerasById = useMemo(() => new Map(cameras.map((c) => [c.id, c])), [cameras]);

  const [statusFilter, setStatusFilter] = useState<TrafficAlertStatus | 'ALL'>('NEW');
  const [alerts, setAlerts] = useState<TrafficAlert[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updatingIds, setUpdatingIds] = useState<Set<number>>(new Set());
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    trafficAlertsService
      .list(statusFilter === 'ALL' ? undefined : statusFilter)
      .then((data) => {
        if (!cancelled) {
          setAlerts(data);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load traffic alerts');
      });
    return () => {
      cancelled = true;
    };
  }, [statusFilter]);

  const onStreamMessage = useCallback(
    (message: unknown) => {
      const alert = message as StreamMessage;
      if (alert.kind !== 'congestion' || typeof alert.id !== 'number') return;
      // Only splice a live push into the list if it matches the filter
      // currently showing -- a NEW alert arriving while viewing "All" or
      // "New" belongs there; one arriving while viewing "Acknowledged"
      // (impossible in practice, since a push only ever fires on creation,
      // always NEW) is guarded anyway for correctness.
      if (statusFilter !== 'ALL' && alert.status !== statusFilter) return;
      setAlerts((prev) => (prev.some((a) => a.id === alert.id) ? prev : [alert as TrafficAlert, ...prev]));
    },
    [statusFilter]
  );
  useAlertsStream(onStreamMessage);

  const resolve = async (id: number, status: 'ACKNOWLEDGED' | 'DISMISSED') => {
    const previous = alerts;
    setUpdatingIds((prev) => new Set(prev).add(id));
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)));
    try {
      await trafficAlertsService.updateStatus(id, status);
      // Once resolved, it no longer belongs in a status-specific filter view.
      if (statusFilter !== 'ALL') setAlerts((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setAlerts(previous);
      setError(err instanceof Error ? err.message : 'Failed to update traffic alert');
    } finally {
      setUpdatingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const sorted = useMemo(
    () => [...alerts].sort((a, b) => new Date(b.triggered_at).getTime() - new Date(a.triggered_at).getTime()),
    [alerts]
  );

  const stats = useMemo(() => {
    const density = sorted.filter((a) => a.alert_type === 'density').length;
    const districts = new Set(sorted.map((a) => a.district ?? 'Unknown district'));
    return { total: sorted.length, density, flow: sorted.length - density, districts: districts.size };
  }, [sorted]);

  const groupedByDistrict = useMemo(() => {
    const groups = new Map<string, TrafficAlert[]>();
    for (const alert of sorted) {
      const district = alert.district ?? 'Unknown district';
      if (!groups.has(district)) groups.set(district, []);
      groups.get(district)!.push(alert);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [sorted]);

  const selected = useMemo(() => sorted.find((a) => a.id === selectedId) ?? null, [sorted, selectedId]);

  const locationLabel = (alert: TrafficAlert): string =>
    alert.alert_type === 'density'
      ? camerasById.get(alert.camera_id ?? -1)?.name || `Camera ${alert.camera_id}`
      : `${camerasById.get(alert.from_camera_id ?? -1)?.name || `Camera ${alert.from_camera_id}`} → ${
          camerasById.get(alert.to_camera_id ?? -1)?.name || `Camera ${alert.to_camera_id}`
        }`;

  return (
    <div className="flex-1 flex h-full min-h-0 w-full">
      {/* Left: filters, at-a-glance stats, and the district-grouped list */}
      <div className="w-full sm:w-96 shrink-0 border-r border-line bg-panel flex flex-col min-h-0">
        <div className="p-2.5 border-b border-line">
          <div className="flex items-center gap-1.5 mb-3">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setStatusFilter(f.value)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition ${
                  statusFilter === f.value
                    ? 'bg-command text-white border-command'
                    : 'bg-ink text-slate-300 border-line hover:border-slate-500'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {[
              { label: 'Shown', value: stats.total },
              { label: 'Density', value: stats.density },
              { label: 'Flow', value: stats.flow },
              { label: 'Districts', value: stats.districts },
            ].map((tile) => (
              <div key={tile.label} className="border border-line rounded bg-ink px-2 py-1.5">
                <p className="text-sm font-bold text-white leading-tight">{tile.value}</p>
                <p className="text-[9px] text-slate-500 uppercase tracking-wide">{tile.label}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && <p className="text-signal-red text-xs px-3 py-2">{error}</p>}
          {!error && sorted.length === 0 && (
            <p className="text-slate-500 text-xs p-3">
              No {statusFilter === 'ALL' ? '' : statusFilter.toLowerCase() + ' '}traffic alerts.
            </p>
          )}

          {groupedByDistrict.map(([district, districtAlerts]) => (
            <div key={district} className="border-b border-line last:border-0">
              <div className="px-3 py-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wide bg-panel-raised/40">
                {district} <span className="text-slate-600 normal-case font-normal">({districtAlerts.length})</span>
              </div>
              {districtAlerts.map((alert) => (
                <button
                  key={alert.id}
                  type="button"
                  onClick={() => setSelectedId(alert.id)}
                  className={`w-full text-left flex items-start gap-2 px-3 py-2 border-l-2 transition-colors ${
                    selectedId === alert.id ? 'bg-command/10 border-l-command' : 'border-l-transparent hover:bg-panel-raised'
                  }`}
                >
                  {alert.alert_type === 'density' ? (
                    <Gauge size={13} className="text-signal-amber shrink-0 mt-0.5" />
                  ) : (
                    <Waypoints size={13} className="text-signal-amber shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-white truncate">{locationLabel(alert)}</p>
                    <p className="text-[11px] text-slate-500 truncate">{timeAgo(alert.triggered_at)}</p>
                  </div>
                  <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[9px] font-semibold ${STATUS_STYLES[alert.status]}`}>
                    {alert.status}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Right: detail + actions for the selected alert */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {!selected ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-slate-600">
            <ShieldAlert size={28} />
            <p className="text-sm text-slate-500">Select a traffic alert to view details and take action</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-3xl">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-start gap-2.5">
                  {selected.alert_type === 'density' ? (
                    <Gauge size={22} className="text-signal-amber shrink-0 mt-0.5" />
                  ) : (
                    <Waypoints size={22} className="text-signal-amber shrink-0 mt-0.5" />
                  )}
                  <div>
                    <p className="text-xl font-bold text-white">{locationLabel(selected)}</p>
                    <p className="text-xs text-slate-500 mt-1">
                      {selected.alert_type === 'density' ? 'Density breach' : 'Flow (corridor) breach'} &middot;{' '}
                      {selected.district ?? 'Unknown district'} &middot; {new Date(selected.triggered_at).toLocaleString()}
                    </p>
                  </div>
                </div>
                <span className={`px-2.5 py-1 rounded-full border text-[11px] font-semibold shrink-0 ${STATUS_STYLES[selected.status]}`}>
                  {selected.status}
                </span>
              </div>

              {canAcknowledge && selected.status === 'NEW' && (
                <div className="flex items-center gap-2 flex-wrap mt-4">
                  <button
                    type="button"
                    disabled={updatingIds.has(selected.id)}
                    onClick={() => resolve(selected.id, 'ACKNOWLEDGED')}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-line bg-panel-raised text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-50 disabled:cursor-wait transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                  >
                    <Check size={13} />
                    Acknowledge
                  </button>
                  <button
                    type="button"
                    disabled={updatingIds.has(selected.id)}
                    onClick={() => resolve(selected.id, 'DISMISSED')}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-line bg-panel-raised text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-50 disabled:cursor-wait transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
                  >
                    <X size={13} />
                    Dismiss
                  </button>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-6">
                <div className="border border-line rounded-lg bg-panel">
                  <div className="px-4 py-3 border-b border-line text-xs font-semibold text-slate-300">Reading</div>
                  <div className="px-4 py-3">
                    <p className="text-xs text-slate-400 mb-1.5">
                      {selected.alert_type === 'density'
                        ? `${selected.metric_value.toLocaleString()} detections (threshold ${selected.threshold_value.toLocaleString()})`
                        : `${selected.metric_value.toLocaleString()} km/h avg speed (threshold ${selected.threshold_value.toLocaleString()})`}
                    </p>
                    <div className="h-1.5 rounded-full bg-ink overflow-hidden">
                      <div
                        className="h-full bg-signal-amber"
                        style={{ width: `${Math.min(severityRatio(selected) / 2, 1) * 100}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-slate-500 mt-1.5">{severityRatio(selected).toFixed(1)}x over threshold</p>
                  </div>
                </div>

                <div className="border border-line rounded-lg bg-panel h-fit">
                  <div className="px-4 py-3 border-b border-line text-xs font-semibold text-slate-300">Accountability</div>
                  <div className="px-4 py-3">
                    {selected.status === 'ACKNOWLEDGED' && selected.acknowledged_by ? (
                      <p className="text-xs text-white">
                        Acknowledged by <span className="font-mono">{selected.acknowledged_by}</span>
                        {selected.acknowledged_at && (
                          <span className="text-slate-500"> &middot; {new Date(selected.acknowledged_at).toLocaleString()}</span>
                        )}
                      </p>
                    ) : selected.status === 'DISMISSED' ? (
                      <p className="text-xs text-slate-500 italic">Dismissed. See Admin &gt; Audit Log for who and when.</p>
                    ) : (
                      <p className="text-xs text-slate-500 italic">Not yet actioned.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default TrafficAlertsSection;
