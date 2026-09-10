// frontend-map/app/admin/DataConsoleSection.tsx
'use client';

import { useEffect, useMemo, useState, useRef } from 'react';
import {
  Database, Download, Upload, RefreshCw, AlertTriangle, Loader2, ChevronDown, FileUp, ScrollText, ArrowRight,
  LogIn, KeyRound, UserCog, Video, MapPin, ShieldAlert, Radar, MoreHorizontal,
  LucideIcon,
} from 'lucide-react';
import { usePermissions } from '@/hooks/usePermissions';
import {
  dataConsoleService, DataConsoleEntity, DataConsoleFormat, DataJob,
} from '@/services/dataConsoleService';

type FilterField =
  | 'district' | 'date_range' | 'status' | 'category' | 'role' | 'scope_type'
  | 'active_only' | 'camera_id' | 'department' | 'badge_number';

interface EntityConfig {
  label: string;
  group: string;
  permission: string;
  fields: FilterField[];
  supportsImport?: boolean;
}

const ENTITY_CONFIG: Record<DataConsoleEntity, EntityConfig> = {
  officers: {
    label: 'Officers', group: 'Identity & Access', permission: 'manage_users_roles',
    fields: ['status', 'date_range'], supportsImport: true,
  },
  postings: {
    label: 'Postings', group: 'Identity & Access', permission: 'manage_users_roles',
    fields: ['role', 'scope_type', 'active_only', 'date_range'],
  },
  registration_requests: {
    label: 'Registration Requests', group: 'Identity & Access', permission: 'manage_users_roles',
    fields: ['status', 'department', 'date_range'],
  },
  cameras: {
    label: 'Cameras', group: 'Camera Registry', permission: 'manage_cameras',
    fields: ['district'], supportsImport: true,
  },
  camera_status_history: {
    label: 'Camera Status History', group: 'Camera Registry', permission: 'manage_cameras',
    fields: ['camera_id', 'district', 'date_range'],
  },
  circles: { label: 'Circles', group: 'Camera Registry', permission: 'manage_circles', fields: ['district'] },
  police_stations: { label: 'Police Stations', group: 'Camera Registry', permission: 'manage_stations', fields: ['district'] },
  coverage_targets: { label: 'Coverage Targets', group: 'Camera Registry', permission: 'manage_cameras', fields: ['district'] },
  audit_logs: {
    label: 'Audit Logs', group: 'Security & Audit', permission: 'view_audit_logs',
    fields: ['category', 'badge_number', 'date_range'],
  },
};

const GROUP_ORDER = ['Identity & Access', 'Camera Registry', 'Security & Audit'];

const REGISTRATION_STATUS_OPTIONS = ['pending', 'approved', 'rejected'];
const OFFICER_STATUS_OPTIONS = ['active', 'pending', 'suspended', 'deactivated'];
const SCOPE_TYPE_OPTIONS = ['platform', 'district'];

const CATEGORY_META: Record<string, { label: string; icon: LucideIcon }> = {
  authentication: { label: 'Login', icon: LogIn },
  credentials: { label: 'Credentials', icon: KeyRound },
  user_management: { label: 'User & Role Mgmt', icon: UserCog },
  camera_registry: { label: 'Camera Registry', icon: Video },
  infrastructure: { label: 'Infrastructure', icon: MapPin },
  alerts: { label: 'Alerts', icon: ShieldAlert },
  detections: { label: 'Detections', icon: Radar },
  other: { label: 'Other', icon: MoreHorizontal },
};

const FORMAT_OPTIONS: { value: DataConsoleFormat; label: string }[] = [
  { value: 'csv', label: 'CSV' },
  { value: 'xlsx', label: 'XLSX' },
  { value: 'json', label: 'JSON' },
];

const inputClass =
  'w-full bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-command';
const labelClass = 'block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1';

// How many of this session's own runs stay visible for quick redownload/
// resubmit -- kept deliberately small. The *permanent* record of every
// export/import ever run already exists as a data_jobs-category entry in
// Audit Log (every run logs a data_job_export/import/resubmit action
// there); this list exists only so the two or three things you just did
// stay one click away, not to duplicate that history.
const MAX_RECENT_RUNS = 3;

interface DataConsoleSectionProps {
  /** Switches the Admin console over to the Audit Log section, pre-scoped
   * by the caller (page.tsx) to actually land there -- Data Console itself
   * has no navigation of its own. */
  onViewAuditLog?: () => void;
}

/** One place to export or import any registry-owned data the platform
 * holds -- pick the entity, narrow it with real filters, see how many rows
 * match before committing, then download as CSV/XLSX/JSON. Reuses the
 * pre-existing generic job engine (admin_ops.py's /admin/data-jobs) rather
 * than a one-off screen per entity; watchlist/detections/traffic-analytics
 * data (backend-watchlist) is a separate phase, not covered here. */
export function DataConsoleSection({ onViewAuditLog }: DataConsoleSectionProps) {
  const { permissions } = usePermissions();

  const visibleEntities = useMemo(
    () => (Object.entries(ENTITY_CONFIG) as [DataConsoleEntity, EntityConfig][])
      .filter(([, cfg]) => permissions.includes(cfg.permission)),
    [permissions]
  );

  const [selected, setSelected] = useState<DataConsoleEntity | null>(null);
  useEffect(() => {
    if (selected === null && visibleEntities.length > 0) setSelected(visibleEntities[0][0]);
  }, [selected, visibleEntities]);

  const [filters, setFilters] = useState<Record<string, unknown>>({});
  const [format, setFormat] = useState<DataConsoleFormat>('csv');
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Session-local only -- never fetched from the server. The permanent
  // history lives in Audit Log; this is just "what did I just do" for
  // one-click redownload/resubmit.
  const [recentRuns, setRecentRuns] = useState<DataJob[]>([]);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addRecentRun = (job: DataJob) => {
    setRecentRuns((prev) => [job, ...prev].slice(0, MAX_RECENT_RUNS));
  };

  // Reset filters/preview/recent-runs whenever the selected entity changes --
  // a district filter (or a just-run job) left over from Cameras has no
  // meaning once you're looking at Postings.
  useEffect(() => {
    setFilters({});
    setPreviewCount(null);
    setError(null);
    setRecentRuns([]);
  }, [selected]);

  // Debounced live row-count as filters change -- the "2,418 rows match"
  // line an officer sees before committing to a run.
  useEffect(() => {
    if (!selected) return;
    setPreviewLoading(true);
    const handle = setTimeout(() => {
      dataConsoleService
        .preview(selected, filters)
        .then(setPreviewCount)
        .catch(() => setPreviewCount(null))
        .finally(() => setPreviewLoading(false));
    }, 350);
    return () => clearTimeout(handle);
  }, [selected, filters]);

  const setFilter = (key: string, value: unknown) => {
    setFilters((prev) => {
      const next = { ...prev };
      if (value === '' || value == null || value === false) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  const handleRun = async () => {
    if (!selected) return;
    setRunning(true);
    setError(null);
    try {
      const job = await dataConsoleService.runExport(selected, format, filters);
      await dataConsoleService.download(job.id, selected, format);
      addRecentRun(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run export');
    } finally {
      setRunning(false);
    }
  };

  /** Simple CSV -> rows parser (no quoted-comma handling) -- adequate for
   * the flat, simple shapes cameras/officers import already expects; a
   * fuller RFC-4180 parser is a natural follow-up if a real export ever
   * needs quoted fields. XLSX import isn't wired up client-side yet (no
   * new frontend dependency added for this pass) -- export supports it,
   * import stays CSV/JSON here. */
  function parseCsv(text: string): Record<string, unknown>[] {
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length === 0) return [];
    const headers = lines[0].split(',').map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const cells = line.split(',');
      const row: Record<string, unknown> = {};
      headers.forEach((header, i) => {
        row[header] = cells[i]?.trim() ?? '';
      });
      return row;
    });
  }

  const handleImportFile = async (file: File) => {
    if (!selected) return;
    setError(null);
    setImporting(true);
    try {
      const text = await file.text();
      const isJson = file.name.toLowerCase().endsWith('.json');
      const rows = isJson ? JSON.parse(text) : parseCsv(text);
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('File contains no rows to import');
      }
      const job = await dataConsoleService.runImport(selected, isJson ? 'json' : 'csv', rows);
      addRecentRun(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import file');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleResubmit = async (jobId: number) => {
    setError(null);
    try {
      const job = await dataConsoleService.resubmitFailed(jobId);
      addRecentRun(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resubmit failed rows');
    }
  };

  const config = selected ? ENTITY_CONFIG[selected] : null;

  if (visibleEntities.length === 0) {
    return <p className="text-xs text-slate-500">You don&apos;t have permission to export or import any data.</p>;
  }

  return (
    <section className="flex gap-5 h-full min-h-0">
      {/* Entity picker, grouped -- same domains as officers navigate the
          rest of Admin by, not a flat list of nine tables. */}
      <nav className="w-56 shrink-0 overflow-y-auto pr-1">
        {GROUP_ORDER.map((group) => {
          const items = visibleEntities.filter(([, cfg]) => cfg.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="mb-4">
              <p className="px-2 mb-1.5 text-[10px] font-semibold tracking-wider text-slate-500 uppercase">{group}</p>
              <div className="flex flex-col gap-0.5">
                {items.map(([entity, cfg]) => (
                  <button
                    key={entity}
                    type="button"
                    onClick={() => setSelected(entity)}
                    className={`text-left px-2.5 py-1.5 rounded text-xs font-medium transition ${
                      selected === entity
                        ? 'bg-command/15 text-command'
                        : 'text-slate-300 hover:bg-panel-raised hover:text-white'
                    }`}
                  >
                    {cfg.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="flex-1 min-w-0 overflow-y-auto">
        {config && selected && (
          <>
            <div className="flex items-center gap-2.5 mb-4">
              <span className="inline-flex p-2 bg-command/10 border border-command/30 text-command rounded-lg">
                <Database size={18} />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-white uppercase tracking-wide">{config.label}</h2>
                <p className="text-[11px] text-slate-500">
                  {config.group} &middot; narrow with filters, then export or import
                </p>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2.5 p-3 mb-4 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <p className="text-[11px]">{error}</p>
              </div>
            )}

            {/* Filter panel -- adapts per entity via config.fields */}
            <div className="border border-line rounded-lg bg-panel p-4 mb-4">
              <p className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-3">Filters</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {config.fields.includes('district') && (
                  <div>
                    <label className={labelClass} htmlFor="filter-district">District</label>
                    <input
                      id="filter-district"
                      className={inputClass}
                      placeholder="e.g. Anand"
                      value={(filters.district as string) ?? ''}
                      onChange={(e) => setFilter('district', e.target.value)}
                    />
                  </div>
                )}
                {config.fields.includes('department') && (
                  <div>
                    <label className={labelClass} htmlFor="filter-department">Department</label>
                    <input
                      id="filter-department"
                      className={inputClass}
                      value={(filters.department as string) ?? ''}
                      onChange={(e) => setFilter('department', e.target.value)}
                    />
                  </div>
                )}
                {config.fields.includes('badge_number') && (
                  <div>
                    <label className={labelClass} htmlFor="filter-badge">Badge Number</label>
                    <input
                      id="filter-badge"
                      className={inputClass}
                      placeholder="e.g. GJ-SA-001"
                      value={(filters.badge_number as string) ?? ''}
                      onChange={(e) => setFilter('badge_number', e.target.value)}
                    />
                  </div>
                )}
                {config.fields.includes('camera_id') && (
                  <div>
                    <label className={labelClass} htmlFor="filter-camera-id">Camera ID</label>
                    <input
                      id="filter-camera-id"
                      type="number"
                      className={inputClass}
                      value={(filters.camera_id as number) ?? ''}
                      onChange={(e) => setFilter('camera_id', e.target.value ? Number(e.target.value) : '')}
                    />
                  </div>
                )}
                {config.fields.includes('role') && (
                  <div>
                    <label className={labelClass} htmlFor="filter-role">Role</label>
                    <input
                      id="filter-role"
                      className={inputClass}
                      placeholder="e.g. district_command"
                      value={(filters.role as string) ?? ''}
                      onChange={(e) => setFilter('role', e.target.value)}
                    />
                  </div>
                )}
                {config.fields.includes('scope_type') && (
                  <div className="relative">
                    <label className={labelClass} htmlFor="filter-scope-type">Scope</label>
                    <select
                      id="filter-scope-type"
                      className={`${inputClass} appearance-none pr-7`}
                      value={(filters.scope_type as string) ?? ''}
                      onChange={(e) => setFilter('scope_type', e.target.value)}
                    >
                      <option value="">Any</option>
                      {SCOPE_TYPE_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                    <ChevronDown size={11} className="absolute right-2 top-[26px] text-slate-500 pointer-events-none" />
                  </div>
                )}
                {config.fields.includes('status') && (
                  <div className="relative">
                    <label className={labelClass} htmlFor="filter-status">Status</label>
                    <select
                      id="filter-status"
                      className={`${inputClass} appearance-none pr-7`}
                      value={(filters.status as string) ?? ''}
                      onChange={(e) => setFilter('status', e.target.value)}
                    >
                      <option value="">Any</option>
                      {(selected === 'officers' ? OFFICER_STATUS_OPTIONS : REGISTRATION_STATUS_OPTIONS).map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                    <ChevronDown size={11} className="absolute right-2 top-[26px] text-slate-500 pointer-events-none" />
                  </div>
                )}
                {config.fields.includes('date_range') && (
                  <>
                    <div>
                      <label className={labelClass} htmlFor="filter-from">From</label>
                      <input
                        id="filter-from"
                        type="date"
                        className={inputClass}
                        value={(filters.date_from as string)?.slice(0, 10) ?? ''}
                        onChange={(e) => setFilter('date_from', e.target.value ? `${e.target.value}T00:00:00Z` : '')}
                      />
                    </div>
                    <div>
                      <label className={labelClass} htmlFor="filter-to">To</label>
                      <input
                        id="filter-to"
                        type="date"
                        className={inputClass}
                        value={(filters.date_to as string)?.slice(0, 10) ?? ''}
                        onChange={(e) => setFilter('date_to', e.target.value ? `${e.target.value}T23:59:59Z` : '')}
                      />
                    </div>
                  </>
                )}
                {config.fields.includes('active_only') && (
                  <label className="flex items-center gap-2 text-xs text-slate-300 mt-5">
                    <input
                      type="checkbox"
                      className="accent-command"
                      checked={!!filters.active_only}
                      onChange={(e) => setFilter('active_only', e.target.checked)}
                    />
                    Active postings only
                  </label>
                )}
              </div>

              {config.fields.includes('category') && (
                <div className="mt-3">
                  <p className={labelClass}>Category</p>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => setFilter('category', '')}
                      className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition ${
                        !filters.category
                          ? 'bg-command text-white border-command'
                          : 'bg-ink text-slate-300 border-line hover:border-slate-500'
                      }`}
                    >
                      All
                    </button>
                    {Object.entries(CATEGORY_META).map(([key, meta]) => {
                      const isActive = filters.category === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setFilter('category', key)}
                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition ${
                            isActive
                              ? 'bg-command text-white border-command'
                              : 'bg-ink text-slate-300 border-line hover:border-slate-500'
                          }`}
                        >
                          <meta.icon size={11} />
                          {meta.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Row count + format + run */}
            <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
              <p className="text-xs text-slate-400">
                {previewLoading ? (
                  <span className="inline-flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Counting…</span>
                ) : previewCount !== null ? (
                  <>
                    <span className="font-mono font-semibold text-white">{previewCount.toLocaleString()}</span> row
                    {previewCount === 1 ? '' : 's'} match
                  </>
                ) : (
                  'Row count unavailable'
                )}
              </p>
              <div className="flex items-center gap-2">
                <div className="flex rounded border border-line overflow-hidden">
                  {FORMAT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setFormat(opt.value)}
                      className={`px-2.5 py-1.5 text-[11px] font-semibold transition ${
                        format === opt.value ? 'bg-command text-white' : 'bg-ink text-slate-300 hover:bg-panel-raised'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={handleRun}
                  disabled={running || previewCount === 0}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-md"
                >
                  {running ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                  Run Export
                </button>
              </div>
            </div>

            {/* Just-ran quick access -- deliberately not a full history.
                Every run already lands in Audit Log's Data Jobs category;
                this is only here so a redownload or a resubmit is one
                click while you're still looking at the result. */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase">Just Ran</p>
                {onViewAuditLog && permissions.includes('view_audit_logs') && (
                  <button
                    type="button"
                    onClick={onViewAuditLog}
                    className="inline-flex items-center gap-1 text-[11px] text-command hover:text-white"
                  >
                    <ScrollText size={11} />
                    Full history in Audit Log
                    <ArrowRight size={11} />
                  </button>
                )}
              </div>
              {recentRuns.length === 0 ? (
                <p className="text-xs text-slate-600 italic py-2">
                  Nothing run yet this session -- every export/import you run here shows up briefly, then lives on
                  in Audit Log.
                </p>
              ) : (
                <div className="border border-line rounded-lg divide-y divide-line overflow-hidden">
                  {recentRuns.map((job) => (
                    <div key={job.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        {job.direction === 'export' ? (
                          <Download size={13} className="text-command shrink-0" />
                        ) : (
                          <Upload size={13} className="text-signal-amber shrink-0" />
                        )}
                        <span className="text-slate-300 truncate">
                          {job.direction === 'export' ? 'Export' : 'Import'} #{job.id} &middot;{' '}
                          {job.total_rows} row{job.total_rows === 1 ? '' : 's'}
                          {job.failed_rows > 0 && (
                            <span className="text-signal-red"> &middot; {job.failed_rows} failed</span>
                          )}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {job.direction === 'export' && (
                          <button
                            type="button"
                            onClick={() => dataConsoleService.download(job.id, job.entity_type, job.format as DataConsoleFormat)}
                            className="text-command hover:text-white"
                            title="Download again"
                          >
                            <Download size={13} />
                          </button>
                        )}
                        {job.direction === 'import' && job.failed_rows > 0 && (
                          <button
                            type="button"
                            onClick={() => handleResubmit(job.id)}
                            className="text-signal-amber hover:text-white"
                            title="Resubmit failed rows"
                          >
                            <RefreshCw size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {config.supportsImport && (
              <div className="mt-6 pt-5 border-t border-line">
                <p className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-2">
                  Bulk Import {config.label}
                </p>
                <p className="text-[11px] text-slate-500 mb-3">
                  Upload a CSV or JSON file. Every row is validated before anything commits -- a row that fails
                  never blocks the rows around it, and failed rows can be resubmitted from Just Ran below once
                  fixed.
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.json"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleImportFile(file);
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={importing}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-line bg-panel-raised text-slate-200 hover:border-command/40 hover:text-command disabled:opacity-50 rounded-md"
                >
                  {importing ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />}
                  {importing ? 'Importing…' : 'Choose file to import'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export default DataConsoleSection;
