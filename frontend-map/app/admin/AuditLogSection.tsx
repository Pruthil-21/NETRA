'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ScrollText,
  Search,
  ChevronDown,
  LogIn,
  KeyRound,
  UserCog,
  Video,
  MapPin,
  ShieldAlert,
  Radar,
  MoreHorizontal,
  LucideIcon,
} from 'lucide-react';
import { adminService, AuditLogOut } from '@/services/adminService';
import { circlesService, Circle } from '@/services/circlesService';
import { useCameraRegistry } from '@/context/CameraRegistryContext';

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' });
}

// One entry per category audit_logs_service.CATEGORIES defines server-side
// (plus the "other" fallback and an "all" pseudo-category for the UI) --
// icon/color/label are presentation-only, kept here rather than server-side
// since the backend's job is just grouping the data, not styling it.
const CATEGORY_META: Record<string, { label: string; icon: LucideIcon; className: string }> = {
  all: { label: 'All Activity', icon: ScrollText, className: 'bg-slate-500/10 text-slate-300 border-slate-500/30' },
  authentication: { label: 'Login', icon: LogIn, className: 'bg-command/10 text-command border-command/30' },
  credentials: { label: 'Credentials', icon: KeyRound, className: 'bg-signal-amber/10 text-signal-amber border-signal-amber/30' },
  user_management: { label: 'User & Role Mgmt', icon: UserCog, className: 'bg-signal-red/10 text-signal-red border-signal-red/30' },
  camera_registry: { label: 'Camera Registry', icon: Video, className: 'bg-signal-green/10 text-signal-green border-signal-green/30' },
  infrastructure: { label: 'Infrastructure', icon: MapPin, className: 'bg-command/10 text-command border-command/30' },
  alerts: { label: 'Alerts', icon: ShieldAlert, className: 'bg-signal-red/10 text-signal-red border-signal-red/30' },
  detections: { label: 'Detections', icon: Radar, className: 'bg-slate-500/10 text-slate-400 border-slate-500/30' },
  other: { label: 'Other', icon: MoreHorizontal, className: 'bg-slate-500/10 text-slate-400 border-slate-500/30' },
};

// Turns the raw (action, resource_type) pair every log actually stores into
// a plain-English sentence -- a police officer scanning this list shouldn't
// have to decode "status_change / alert" as "someone acknowledged a match."
const ACTION_DESCRIPTIONS: Record<string, string> = {
  'login:officer': 'Logged in',
  'change_password:officer': 'Changed their own password',
  'reset_password:officer': "Reset an officer's password",
  'reassign_posting:posting': 'Reassigned a posting',
  'edit_role_permissions:role': "Edited a role's permissions",
  'create:camera': 'Added a camera',
  'update:camera': 'Updated a camera',
  'delete:camera': 'Removed a camera',
  'create:circle': 'Added an area',
  'update:circle': 'Updated an area',
  'delete:circle': 'Removed an area',
  'create:police_station': 'Added a police station',
  'update:police_station': 'Updated a police station',
  'delete:police_station': 'Removed a police station',
  'create:coverage_target': 'Added a coverage target',
  'update:coverage_target': 'Updated a coverage target',
  'delete:coverage_target': 'Removed a coverage target',
  'status_change:alert': "Changed an alert's status",
  'create:alert': 'Watchlist alert generated',
  'create:detection': 'Plate detection recorded',
};

function describeLog(log: AuditLogOut): string {
  return ACTION_DESCRIPTIONS[`${log.action}:${log.resource_type}`] ?? `${log.action} ${log.resource_type}`;
}

// Every mutating admin/registry action writes here via audit_service.log --
// this is the first (and only) place any of it is actually readable, rather
// than sitting in the database with no UI at all.
export function AuditLogSection() {
  const { cameras } = useCameraRegistry();
  const [logs, setLogs] = useState<AuditLogOut[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [categories, setCategories] = useState<string[]>([]);
  const [activeCategory, setActiveCategory] = useState('all');

  const [circles, setCircles] = useState<Circle[]>([]);
  const [badgeFilter, setBadgeFilter] = useState('');
  const [districtFilter, setDistrictFilter] = useState('');
  const [areaFilter, setAreaFilter] = useState('');
  const [cameraIdFilter, setCameraIdFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => {
    adminService.listAuditLogCategories().then(setCategories).catch(() => {
      // Non-fatal: the "All Activity" chip alone still works without this.
    });
    circlesService.listCircles().then(setCircles).catch(() => {
      // Non-fatal: the Area dropdown just shows no options until it retries.
    });
  }, []);

  const districts = useMemo(
    () => Array.from(new Set(cameras.map((cam) => cam.dept))).sort(),
    [cameras]
  );
  // Narrowed to the selected district once one is picked, same "District ->
  // Area" relationship as the camera hierarchy tree -- otherwise every area
  // platform-wide, which is rarely what an officer searching by location wants.
  const areaOptions = useMemo(
    () => (districtFilter ? circles.filter((c) => c.district === districtFilter) : circles),
    [circles, districtFilter]
  );

  const load = (opts: { cursor?: number; append?: boolean } = {}) => {
    const setBusy = opts.append ? setLoadingMore : setLoading;
    setBusy(true);
    setLoadError(null);
    adminService
      .listAuditLogs({
        badge_number: badgeFilter || undefined,
        category: activeCategory === 'all' ? undefined : activeCategory,
        camera_id: cameraIdFilter ? Number(cameraIdFilter) : undefined,
        camera_district: districtFilter || undefined,
        camera_circle_id: areaFilter ? Number(areaFilter) : undefined,
        from: dateFrom ? new Date(dateFrom).toISOString() : undefined,
        to: dateTo ? new Date(dateTo).toISOString() : undefined,
        cursor: opts.cursor,
      })
      .then((page) => {
        setLogs((prev) => (opts.append ? [...prev, ...page.logs] : page.logs));
        setNextCursor(page.next_cursor);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load audit logs'))
      .finally(() => setBusy(false));
  };

  // Initial load only -- filter changes apply on explicit "Apply" (or a
  // category chip click) so a half-typed badge number doesn't refetch on
  // every keystroke.
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectCategory = (category: string) => {
    setActiveCategory(category);
    // Category chips act immediately (no separate "Apply" click) -- they're
    // the primary navigation for this page, same as a tab strip.
    setLoading(true);
    setLoadError(null);
    adminService
      .listAuditLogs({
        badge_number: badgeFilter || undefined,
        category: category === 'all' ? undefined : category,
        camera_id: cameraIdFilter ? Number(cameraIdFilter) : undefined,
        camera_district: districtFilter || undefined,
        camera_circle_id: areaFilter ? Number(areaFilter) : undefined,
        from: dateFrom ? new Date(dateFrom).toISOString() : undefined,
        to: dateTo ? new Date(dateTo).toISOString() : undefined,
      })
      .then((page) => {
        setLogs(page.logs);
        setNextCursor(page.next_cursor);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load audit logs'))
      .finally(() => setLoading(false));
  };

  return (
    <section className="mt-8">
      <div className="flex items-center gap-3 mb-1">
        <span className="inline-flex p-2 bg-slate-500/10 border border-slate-500/30 text-slate-400 rounded-lg">
          <ScrollText size={18} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-white uppercase tracking-wide">Audit Log</h2>
          <p className="text-[11px] text-slate-500">Every sensitive action, with who did it, where, and when</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {['all', ...categories].map((category) => {
          const meta = CATEGORY_META[category] ?? CATEGORY_META.other;
          const Icon = meta.icon;
          const isActive = activeCategory === category;
          return (
            <button
              key={category}
              type="button"
              onClick={() => selectCategory(category)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-[11px] font-medium transition-colors ${
                isActive ? meta.className : 'bg-panel-raised text-slate-400 border-line hover:text-white hover:border-slate-500'
              }`}
            >
              <Icon size={12} />
              {meta.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap gap-2.5 items-end">
        <div>
          <label htmlFor="audit-badge" className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
            Badge Number
          </label>
          <input
            id="audit-badge"
            value={badgeFilter}
            onChange={(e) => setBadgeFilter(e.target.value)}
            placeholder="e.g. GJ-1042"
            className="bg-ink border border-line rounded-md px-2.5 py-1.5 text-xs text-white w-32 focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
          />
        </div>
        <div>
          <label htmlFor="audit-camera-id" className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
            Camera ID
          </label>
          <input
            id="audit-camera-id"
            type="number"
            value={cameraIdFilter}
            onChange={(e) => setCameraIdFilter(e.target.value)}
            placeholder="e.g. 7"
            className="bg-ink border border-line rounded-md px-2.5 py-1.5 text-xs text-white w-24 focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
          />
        </div>
        <div>
          <label htmlFor="audit-district" className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
            District / City
          </label>
          <select
            id="audit-district"
            value={districtFilter}
            onChange={(e) => {
              setDistrictFilter(e.target.value);
              setAreaFilter('');
            }}
            className="bg-ink border border-line rounded-md px-2.5 py-1.5 text-xs text-white w-40 focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
          >
            <option value="">Any district</option>
            {districts.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="audit-area" className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
            Area
          </label>
          <select
            id="audit-area"
            value={areaFilter}
            onChange={(e) => setAreaFilter(e.target.value)}
            className="bg-ink border border-line rounded-md px-2.5 py-1.5 text-xs text-white w-40 focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
          >
            <option value="">Any area</option>
            {areaOptions.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="audit-from" className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
            From
          </label>
          <input
            id="audit-from"
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="bg-ink border border-line rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
          />
        </div>
        <div>
          <label htmlFor="audit-to" className="block text-[10px] font-semibold tracking-wider text-slate-500 uppercase mb-1">
            To
          </label>
          <input
            id="audit-to"
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="bg-ink border border-line rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition"
          />
        </div>
        <button
          type="button"
          onClick={() => load()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md uppercase tracking-wide transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-command"
        >
          <Search size={12} />
          Apply
        </button>
      </div>

      <div className="mt-4">
        {loadError && (
          <div className="flex items-start gap-2.5 p-3 mb-4 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-semibold">Failed to load audit logs</p>
              <p className="text-[11px] text-signal-red/80">{loadError}</p>
            </div>
            <button
              type="button"
              onClick={() => load()}
              className="ml-auto shrink-0 text-[11px] px-2.5 py-1 rounded bg-panel-raised border border-line text-slate-200 hover:text-white"
            >
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col gap-2 animate-pulse" aria-label="Loading audit logs">
            {[1, 2, 3, 4].map((item) => (
              <div key={item} className="h-10 bg-panel-raised rounded" />
            ))}
          </div>
        ) : !loadError && logs.length === 0 ? (
          <div className="flex flex-col items-center text-center gap-2 py-16 text-slate-500">
            <ScrollText size={28} className="text-slate-600" />
            <p className="text-xs font-semibold text-slate-400">No audit entries match these filters</p>
          </div>
        ) : (
          <div className="border border-line rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-panel-raised text-slate-500 text-[10px] uppercase tracking-wider">
                    <th className="text-left font-semibold px-3 py-2">Timestamp</th>
                    <th className="text-left font-semibold px-3 py-2">Officer</th>
                    <th className="text-left font-semibold px-3 py-2">What happened</th>
                    <th className="text-left font-semibold px-3 py-2">Where</th>
                    <th className="text-left font-semibold px-3 py-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => {
                    const meta = CATEGORY_META[log.category] ?? CATEGORY_META.other;
                    const Icon = meta.icon;
                    return (
                      <tr key={log.id} className="border-t border-line hover:bg-panel-raised/50">
                        <td className="px-3 py-2 font-mono text-slate-400 whitespace-nowrap">{formatTimestamp(log.timestamp)}</td>
                        <td className="px-3 py-2">
                          <p className="text-slate-200">{log.actor_name ?? (log.badge_number ? 'Unknown officer' : 'System')}</p>
                          {log.badge_number && <p className="font-mono text-slate-500">{log.badge_number}</p>}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium mb-1 ${meta.className}`}
                          >
                            <Icon size={10} />
                            {meta.label}
                          </span>
                          <p className="text-slate-300">
                            {describeLog(log)}
                            {log.resource_id != null && !log.camera_name && (
                              <span className="text-slate-600"> (#{log.resource_id})</span>
                            )}
                          </p>
                        </td>
                        <td className="px-3 py-2 text-slate-400">
                          {log.camera_name ? (
                            <>
                              <p className="text-slate-300 truncate">{log.camera_name}</p>
                              <p className="text-slate-600">
                                {[log.camera_area, log.camera_district].filter(Boolean).join(', ') || '—'}
                              </p>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-500">{log.reason_code ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {nextCursor != null && (
              <div className="p-2.5 border-t border-line bg-panel-raised/30 flex justify-center">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => load({ cursor: nextCursor, append: true })}
                  className="inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded bg-panel-raised border border-line text-slate-300 hover:text-white disabled:opacity-50"
                >
                  <ChevronDown size={12} />
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export default AuditLogSection;
