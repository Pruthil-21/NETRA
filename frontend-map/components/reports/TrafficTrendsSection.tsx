'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { Loader2, AlertTriangle, Gauge, Waypoints } from 'lucide-react';
import { trafficAnalyticsService, DensityTrend, FlowTrend, TrendBucket } from '@/services/trafficAnalyticsService';

function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const inputClass =
  'bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command';
const labelClass = 'block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1';

function formatBucketLabel(iso: string, bucket: TrendBucket): string {
  const d = new Date(iso);
  return bucket === 'hour'
    ? d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', hour12: false })
    : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** Historical density/flow trends over an arbitrary date range -- the
 * counterpart to the Map page's Density/Flow layers, which only ever show
 * a live-rolling-window or single-hour-of-day snapshot. Visibility is
 * gated by the parent Reports page's tab bar (view_analytics), the same
 * way TrafficAlertsSection doesn't re-check acknowledge_alerts for its own
 * visibility, only for its action buttons. */
export function TrafficTrendsSection() {
  const [dateFrom, setDateFrom] = useState(() => isoDateDaysAgo(7));
  const [dateTo, setDateTo] = useState(() => todayIso());
  const [bucket, setBucket] = useState<TrendBucket>('day');

  const [density, setDensity] = useState<DensityTrend | null>(null);
  const [flow, setFlow] = useState<FlowTrend | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const query = { from: `${dateFrom}T00:00:00Z`, to: `${dateTo}T23:59:59Z`, bucket };
    Promise.all([
      trafficAnalyticsService.fetchDensityTrend(query),
      trafficAnalyticsService.fetchFlowTrend(query),
    ])
      .then(([d, f]) => {
        setDensity(d);
        setFlow(f);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load traffic trends'))
      .finally(() => setLoading(false));
  }, [dateFrom, dateTo, bucket]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only; further loads are explicit via the Apply button
  }, []);

  const densityChartData = (density?.trend ?? []).map((p) => ({
    label: formatBucketLabel(p.bucket_start, bucket),
    count: p.count,
  }));
  const flowChartData = (flow?.trend ?? []).map((p) => ({
    label: formatBucketLabel(p.bucket_start, bucket),
    count: p.count,
  }));

  return (
    <div>
      <div className="border border-line rounded-lg bg-panel p-4 mb-5 flex items-end gap-3 flex-wrap">
        <div>
          <label className={labelClass} htmlFor="analytics-from">From</label>
          <input id="analytics-from" type="date" className={inputClass} value={dateFrom} max={dateTo}
            onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div>
          <label className={labelClass} htmlFor="analytics-to">To</label>
          <input id="analytics-to" type="date" className={inputClass} value={dateTo} min={dateFrom} max={todayIso()}
            onChange={(e) => setDateTo(e.target.value)} />
        </div>
        <div className="flex rounded border border-line overflow-hidden">
          {(['day', 'hour'] as const).map((b) => (
            <button key={b} type="button" onClick={() => setBucket(b)}
              className={`px-2.5 py-1.5 text-[11px] font-semibold transition ${
                bucket === b ? 'bg-command text-white' : 'bg-ink text-slate-300 hover:bg-panel-raised'
              }`}>
              {b === 'day' ? 'Daily' : 'Hourly'}
            </button>
          ))}
        </div>
        <button type="button" onClick={load} disabled={loading}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim disabled:opacity-40 text-white rounded-md">
          {loading ? <Loader2 size={13} className="animate-spin" /> : null}
          Apply
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2.5 p-3 mb-4 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p className="text-[11px]">{error}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section className="border border-line rounded-lg bg-panel p-4">
          <div className="flex items-center gap-1.5 mb-2">
            <Gauge size={13} className="text-command" />
            <p className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Density Trend</p>
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={densityChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} minTickGap={20} />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #2a2f3a', fontSize: 11 }} />
                <Line type="monotone" dataKey="count" stroke="#4f8cff" strokeWidth={2} dot={false} name="Detections" />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase mt-3 mb-1.5">Busiest cameras</p>
          <ol className="text-xs text-slate-300 space-y-1">
            {(density?.top_cameras ?? []).slice(0, 5).map((c) => (
              <li key={c.camera_id} className="flex justify-between">
                <span>Camera {c.camera_id}</span>
                <span className="font-mono text-slate-500">{c.count.toLocaleString()}</span>
              </li>
            ))}
            {density && density.top_cameras.length === 0 && <li className="text-slate-600 italic">No data in range</li>}
          </ol>
        </section>

        <section className="border border-line rounded-lg bg-panel p-4">
          <div className="flex items-center gap-1.5 mb-2">
            <Waypoints size={13} className="text-command" />
            <p className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Flow Trend</p>
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={flowChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} minTickGap={20} />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: '#161b22', border: '1px solid #2a2f3a', fontSize: 11 }} />
                <Line type="monotone" dataKey="count" stroke="#f5a623" strokeWidth={2} dot={false} name="Transitions" />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase mt-3 mb-1.5">Busiest corridors</p>
          <ol className="text-xs text-slate-300 space-y-1">
            {(flow?.top_corridors ?? []).slice(0, 5).map((c) => (
              <li key={`${c.from_camera_id}-${c.to_camera_id}`} className="flex justify-between">
                <span>Cam {c.from_camera_id} &rarr; {c.to_camera_id}</span>
                <span className="font-mono text-slate-500">
                  {c.transitions.toLocaleString()}{c.avg_speed_kmh != null ? ` · ${c.avg_speed_kmh} km/h` : ''}
                </span>
              </li>
            ))}
            {flow && flow.top_corridors.length === 0 && <li className="text-slate-600 italic">No data in range</li>}
          </ol>
        </section>
      </div>
    </div>
  );
}

export default TrafficTrendsSection;
