'use client';

import { useCallback, useEffect, useState } from 'react';
import { Gauge, Waypoints, Check, X, Loader2 } from 'lucide-react';
import { usePermissions } from '@/hooks/usePermissions';
import { useAlertsStream } from '@/hooks/useAlertsStream';
import { trafficAlertsService, TrafficAlert } from '@/services/trafficAlertsService';

/** A message pushed over /alerts/stream carries a `kind` discriminator
 * (see alerts_stream.py) so this one WS connection can serve both the
 * pre-existing watchlist-match alerts and these newer congestion ones --
 * every field below is TrafficAlert's own shape, just not guaranteed to be
 * present on a watchlist-kind message, which this component ignores. */
interface StreamMessage extends Partial<TrafficAlert> {
  kind?: string;
}

/** Compact live panel for density/flow threshold breaches (see
 * backend-watchlist's traffic_alerts table) -- placed on the Map page
 * itself, opposite MapFilterControl, since an officer looking at the
 * Density/Flow layer is exactly who a congestion alert is for. The full
 * acknowledge/dismiss history lives on the /alerts page's Traffic tab;
 * this is the same "quick access to what just happened" role Data
 * Console's "Just Ran" list plays relative to Audit Log. */
export function TrafficAlertsPanel() {
  const { permissions } = usePermissions();
  const canView = permissions.includes('view_analytics');
  const canAcknowledge = permissions.includes('acknowledge_alerts');

  const [alerts, setAlerts] = useState<TrafficAlert[]>([]);
  const [actingOn, setActingOn] = useState<number | null>(null);

  useEffect(() => {
    if (!canView) return;
    trafficAlertsService
      .list('NEW')
      .then(setAlerts)
      .catch(() => {
        // Non-fatal -- the panel just starts empty until the next push or a
        // remount; matches every other best-effort fetch in this app.
      });
  }, [canView]);

  const onStreamMessage = useCallback((message: unknown) => {
    const alert = message as StreamMessage;
    if (alert.kind !== 'congestion' || typeof alert.id !== 'number') return;
    setAlerts((prev) => (prev.some((a) => a.id === alert.id) ? prev : [alert as TrafficAlert, ...prev]));
  }, []);
  useAlertsStream(onStreamMessage);

  const resolve = async (id: number, status: 'ACKNOWLEDGED' | 'DISMISSED') => {
    setActingOn(id);
    try {
      await trafficAlertsService.updateStatus(id, status);
      setAlerts((prev) => prev.filter((a) => a.id !== id));
    } catch {
      // Leave it in the list -- an officer can just retry the click.
    } finally {
      setActingOn(null);
    }
  };

  if (!canView || alerts.length === 0) return null;

  return (
    <div className="absolute top-3 left-3 z-[1000] w-64 rounded-lg bg-panel border border-signal-amber/40 shadow-xl overflow-hidden">
      <div className="px-3 py-2 border-b border-line bg-signal-amber/10">
        <p className="text-[11px] font-semibold tracking-wide text-signal-amber uppercase">
          Traffic Alerts &middot; {alerts.length}
        </p>
      </div>
      <div className="max-h-64 overflow-y-auto divide-y divide-line">
        {alerts.map((alert) => (
          <div key={alert.id} className="px-3 py-2 text-xs">
            <div className="flex items-center gap-1.5 text-slate-200 font-medium">
              {alert.alert_type === 'density' ? <Gauge size={12} className="text-signal-amber shrink-0" /> : (
                <Waypoints size={12} className="text-signal-amber shrink-0" />
              )}
              {alert.alert_type === 'density' ? (
                <span>Camera {alert.camera_id} &middot; {alert.metric_value} detections</span>
              ) : (
                <span>Cam {alert.from_camera_id}&rarr;{alert.to_camera_id} &middot; {alert.metric_value} km/h</span>
              )}
            </div>
            {alert.district && <p className="text-[10px] text-slate-500 mt-0.5">{alert.district}</p>}
            {canAcknowledge && (
              <div className="flex items-center gap-2 mt-1.5">
                <button
                  type="button"
                  disabled={actingOn === alert.id}
                  onClick={() => resolve(alert.id, 'ACKNOWLEDGED')}
                  className="inline-flex items-center gap-1 text-[10px] font-semibold text-command hover:text-white disabled:opacity-40"
                >
                  {actingOn === alert.id ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} />}
                  Acknowledge
                </button>
                <button
                  type="button"
                  disabled={actingOn === alert.id}
                  onClick={() => resolve(alert.id, 'DISMISSED')}
                  className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400 hover:text-white disabled:opacity-40"
                >
                  <X size={10} />
                  Dismiss
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default TrafficAlertsPanel;
