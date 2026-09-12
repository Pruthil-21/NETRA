// frontend-map/app/admin/FederationSection.tsx
'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Radio, RefreshCw, AlertTriangle, CheckCircle2, Clock, Link2, Search,
  ChevronDown, X, Video, MapPin, Loader2, Ban, Plus, Pencil, Trash2,
} from 'lucide-react';
import { federationService, FederationSource, FederationSourceInput, FederationCamera } from '@/services/federationService';
import { useCameraRegistry } from '@/context/CameraRegistryContext';

const AUTO_REFRESH_MS = 20_000;

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function timeUntil(iso: string | null): string {
  if (!iso) return '—';
  const sec = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  if (sec <= 0) return 'due now';
  if (sec < 60) return `in ${sec}s`;
  return `in ${Math.floor(sec / 60)}m`;
}

/** connected = at least one successful sync and not currently overdue;
 * retrying = has attempted and failed at least once (or is overdue);
 * initializing = configured but no attempt has landed yet. Mirrors the raw
 * `status` the middleware reports, but folds `overdue` into the same three
 * visual buckets rather than adding a fourth badge color. */
function sourceHealth(source: FederationSource): { label: string; className: string; Icon: typeof CheckCircle2 } {
  if (source.overdue) return { label: 'Overdue', className: 'bg-signal-red/10 text-signal-red border-signal-red/30', Icon: AlertTriangle };
  if (source.status === 'retrying') return { label: 'Retrying', className: 'bg-signal-amber/10 text-signal-amber border-signal-amber/30', Icon: RefreshCw };
  if (source.last_success) return { label: 'Connected', className: 'bg-signal-green/10 text-signal-green border-signal-green/30', Icon: CheckCircle2 };
  return { label: 'Initializing', className: 'bg-slate-500/10 text-slate-400 border-slate-500/30', Icon: Clock };
}

const ERROR_CODE_HINTS: Record<string, string> = {
  http_302: 'Source redirected an authenticated request -- session/login likely failing.',
  http_403: 'Source rejected the request as forbidden -- check credentials or an upstream firewall/WAF rule.',
  http_401: 'Source rejected the credentials -- verify the login/service key is current.',
  http_404: 'Source endpoint not found -- check the configured inventory URL.',
  http_429: 'Source is rate-limiting requests.',
  http_500: 'Source returned a server error.',
  http_502: 'Source (or a proxy in front of it) is unreachable/misconfigured.',
  http_503: 'Source temporarily unavailable.',
};

function errorHint(code: string | null): string | null {
  if (!code) return null;
  return ERROR_CODE_HINTS[code] ?? 'Sync failed -- see worker logs for detail.';
}

interface MappingPickerProps {
  camera: FederationCamera;
  onClose: () => void;
  onMapped: () => void;
}

/** Inline "map to an existing registry camera" picker -- searches the
 * already-loaded camera registry (no new endpoint) by name/dept, and posts
 * the mapping through our own RBAC proxy. Deliberately does not create or
 * modify registry cameras: onboarding a brand-new camera stays the
 * registry's own flow, this only links an inventory row to one that
 * already exists (per the federation handoff's ownership boundary). */
function MappingPicker({ camera, onClose, onMapped }: MappingPickerProps) {
  const { cameras } = useCameraRegistry();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q
      ? cameras.filter((c) => c.name.toLowerCase().includes(q) || c.dept.toLowerCase().includes(q) || String(c.id).includes(q))
      : cameras;
    return pool.slice(0, 40);
  }, [cameras, query]);

  const handleConfirm = async () => {
    if (selectedId == null) return;
    setSubmitting(true);
    setError(null);
    try {
      await federationService.createMapping(camera.id, selectedId);
      onMapped();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to map camera');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-2 p-3 rounded-lg border border-command/30 bg-command/5">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-semibold text-white">
          Map <span className="text-command">{camera.name}</span> to a registry camera
        </p>
        <button type="button" onClick={onClose} aria-label="Cancel mapping" className="text-slate-500 hover:text-white">
          <X size={13} />
        </button>
      </div>

      <div className="relative mb-2">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search registry cameras by name, district, or ID"
          autoFocus
          className="w-full bg-ink border border-line rounded pl-7 pr-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-command"
        />
      </div>

      <div className="max-h-40 overflow-y-auto rounded border border-line divide-y divide-line mb-2">
        {matches.length === 0 && <p className="p-2.5 text-[11px] text-slate-600 italic">No registry cameras match</p>}
        {matches.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setSelectedId(c.id)}
            className={`w-full text-left px-2.5 py-1.5 text-[11px] flex items-center justify-between gap-2 ${
              selectedId === c.id ? 'bg-command/15 text-white' : 'text-slate-300 hover:bg-panel-raised'
            }`}
          >
            <span className="truncate">{c.name}</span>
            <span className="shrink-0 text-slate-500">{c.dept} · #{c.id}</span>
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-start gap-2 p-2 mb-2 rounded border border-signal-red/30 bg-signal-red/10 text-signal-red">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <p className="text-[11px]">{error}</p>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="px-2.5 py-1.5 text-xs font-medium text-slate-400 hover:text-white"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={selectedId == null || submitting}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim disabled:opacity-40 disabled:cursor-not-allowed text-white rounded"
        >
          {submitting ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />}
          Confirm mapping
        </button>
      </div>
    </div>
  );
}

const EMPTY_SOURCE_INPUT: FederationSourceInput = {
  name: '',
  adapter: 'mediamtx',
  inventory_url: '',
  playback_base: 'https://stream.digdhrishti.me',
  path_prefix: '',
  representative: false,
  force_ipv4: false,
  login_url: '',
  login_email_env: '',
  login_password_env: '',
  headers_env: '',
};

interface SourceFormModalProps {
  /** null = creating a new source (id is a free-text field); a string =
   * editing that existing source (id is fixed, form pre-fills from
   * getSourceConfig). */
  editingId: string | null;
  onClose: () => void;
  onSaved: () => void;
}

/** Add/edit a federation source. Deliberately does not create/verify any
 * credential -- `headers_env`/`login_email_env`/`login_password_env` are
 * environment VARIABLE NAMES the federation container must already have
 * set (in .env.federation); this form can only reference an existing one,
 * never define a new secret value from the browser. */
function SourceFormModal({ editingId, onClose, onSaved }: SourceFormModalProps) {
  const isEditing = editingId !== null;
  const [id, setId] = useState(editingId ?? '');
  const [input, setInput] = useState<FederationSourceInput>(EMPTY_SOURCE_INPUT);
  const [loading, setLoading] = useState(isEditing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEditing || !editingId) return;
    federationService
      .getSourceConfig(editingId)
      .then(setInput)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load source'))
      .finally(() => setLoading(false));
  }, [isEditing, editingId]);

  const set = <K extends keyof FederationSourceInput>(key: K, value: FederationSourceInput[K]) =>
    setInput((prev) => ({ ...prev, [key]: value }));

  const idValid = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);

  const handleSave = async () => {
    setError(null);
    if (!isEditing && !idValid) {
      setError('Source ID must be lowercase letters, digits, "-" or "_", starting with a letter or digit.');
      return;
    }
    if (!input.name.trim() || !input.inventory_url.trim() || !input.playback_base.trim()) {
      setError('Name, inventory URL, and playback base are required.');
      return;
    }
    setSaving(true);
    try {
      await federationService.upsertSource(id, input);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save source');
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-command';
  const labelClass = 'block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[2000] p-4">
      <div className="bg-panel border border-line rounded-lg w-full max-w-lg max-h-[85vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 className="text-sm font-semibold text-white">{isEditing ? `Edit "${editingId}"` : 'Add Federation Source'}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-slate-500 hover:text-white">
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <p className="px-5 py-8 text-xs text-slate-500 text-center">Loading source config…</p>
        ) : (
          <div className="px-5 py-4 overflow-y-auto flex-1 space-y-3">
            <div>
              <label className={labelClass} htmlFor="source-id">Source ID</label>
              <input
                id="source-id"
                value={id}
                disabled={isEditing}
                onChange={(e) => setId(e.target.value.trim().toLowerCase())}
                placeholder="e.g. anand-mediamtx"
                className={`${inputClass} font-mono disabled:opacity-50 disabled:cursor-not-allowed`}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="source-name">Name</label>
              <input id="source-name" value={input.name} onChange={(e) => set('name', e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass} htmlFor="source-adapter">Adapter</label>
              <select
                id="source-adapter"
                value={input.adapter}
                onChange={(e) => set('adapter', e.target.value as FederationSourceInput['adapter'])}
                className={inputClass}
              >
                <option value="mediamtx">mediamtx</option>
                <option value="organizer">organizer</option>
                <option value="delta">delta</option>
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="source-inventory-url">
                Inventory URL {input.adapter === 'mediamtx' && <span className="normal-case font-normal text-slate-600">(MediaMTX API, e.g. http://host:9997/v3/paths/list)</span>}
              </label>
              <input id="source-inventory-url" value={input.inventory_url} onChange={(e) => set('inventory_url', e.target.value)} className={`${inputClass} font-mono`} />
            </div>
            <div>
              <label className={labelClass} htmlFor="source-playback-base">Playback Base</label>
              <input id="source-playback-base" value={input.playback_base} onChange={(e) => set('playback_base', e.target.value)} className={`${inputClass} font-mono`} />
            </div>
            <div>
              <label className={labelClass} htmlFor="source-path-prefix">Path Prefix (optional filter)</label>
              <input id="source-path-prefix" value={input.path_prefix ?? ''} onChange={(e) => set('path_prefix', e.target.value)} placeholder="e.g. stream/demo-" className={`${inputClass} font-mono`} />
            </div>

            {input.adapter === 'organizer' && (
              <div className="border border-line rounded-md p-3 space-y-3 bg-panel-raised/40">
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Organizer login</p>
                <div>
                  <label className={labelClass} htmlFor="source-login-url">Login URL</label>
                  <input id="source-login-url" value={input.login_url ?? ''} onChange={(e) => set('login_url', e.target.value)} className={`${inputClass} font-mono`} />
                </div>
                <div>
                  <label className={labelClass} htmlFor="source-login-email-env">Login email env var name</label>
                  <input id="source-login-email-env" value={input.login_email_env ?? ''} onChange={(e) => set('login_email_env', e.target.value)} placeholder="e.g. ORGANIZER_EMAIL" className={`${inputClass} font-mono`} />
                </div>
                <div>
                  <label className={labelClass} htmlFor="source-login-password-env">Login password env var name</label>
                  <input id="source-login-password-env" value={input.login_password_env ?? ''} onChange={(e) => set('login_password_env', e.target.value)} placeholder="e.g. ORGANIZER_PASSWORD" className={`${inputClass} font-mono`} />
                </div>
                <p className="text-[10px] text-slate-600">
                  These must already exist as real environment variables in the federation container -- this form only references the name, it can&apos;t set the value.
                </p>
              </div>
            )}

            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input type="checkbox" checked={!!input.representative} onChange={(e) => set('representative', e.target.checked)} className="accent-command" />
              Replay / demo footage, not a live capture
            </label>

            {error && (
              <p className="flex items-center gap-1.5 text-[11px] text-signal-red">
                <AlertTriangle size={12} /> {error}
              </p>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-line">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim disabled:opacity-50 text-white rounded-md uppercase tracking-wide transition"
          >
            {saving && <Loader2 size={12} className="animate-spin" />}
            {isEditing ? 'Save Changes' : 'Add Source'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function FederationSection() {
  const [sources, setSources] = useState<FederationSource[]>([]);
  const [cameras, setCameras] = useState<FederationCamera[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [syncingSource, setSyncingSource] = useState<string | null>(null);
  const [deletingSource, setDeletingSource] = useState<string | null>(null);
  const [sourceModal, setSourceModal] = useState<{ editingId: string | null } | null>(null);

  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [mappedFilter, setMappedFilter] = useState<'all' | 'mapped' | 'unmapped'>('all');
  const [mappingCameraId, setMappingCameraId] = useState<string | null>(null);

  const load = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setRefreshing(true);
    setError(null);
    try {
      const [sourcesResult, camerasResult] = await Promise.all([
        federationService.listSources(),
        federationService.listAllCameras(),
      ]);
      setSources(sourcesResult);
      setCameras(camerasResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load federation inventory');
    } finally {
      setLoading(false);
      if (showSpinner) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(false);
    const interval = setInterval(() => load(false), AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  const handleSync = async (sourceId: string) => {
    setSyncingSource(sourceId);
    setError(null);
    try {
      await federationService.syncSource(sourceId);
      // The trigger is async server-side (queued to a worker); give it a
      // moment before pulling fresh status rather than reading last cycle's.
      setTimeout(() => load(true), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger sync');
    } finally {
      setSyncingSource(null);
    }
  };

  const handleDelete = async (sourceId: string) => {
    setDeletingSource(sourceId);
    setError(null);
    try {
      await federationService.deleteSource(sourceId);
      load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove source');
    } finally {
      setDeletingSource(null);
    }
  };

  const stats = useMemo(() => {
    const mapped = cameras.filter((c) => c.registry_camera_id != null).length;
    const errored = sources.filter((s) => s.overdue || s.error_code).length;
    return { total: cameras.length, mapped, unmapped: cameras.length - mapped, sources: sources.length, errored };
  }, [cameras, sources]);

  const filteredCameras = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cameras.filter((c) => {
      if (sourceFilter !== 'all' && c.source_id !== sourceFilter) return false;
      if (mappedFilter === 'mapped' && c.registry_camera_id == null) return false;
      if (mappedFilter === 'unmapped' && c.registry_camera_id != null) return false;
      if (q && !c.name.toLowerCase().includes(q) && !c.external_id.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [cameras, search, sourceFilter, mappedFilter]);

  if (loading) return <p className="text-xs text-slate-500">Loading federation inventory...</p>;

  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="flex items-center gap-3">
          <span className="inline-flex p-2 bg-command/10 border border-command/30 text-command rounded-lg">
            <Radio size={18} />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-white uppercase tracking-wide">Federation &amp; Camera Inventory</h2>
            <p className="text-[11px] text-slate-500">
              External camera sources bridged through the standalone inventory service -- read-only discovery, mapped explicitly to registry cameras
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setSourceModal({ editingId: null })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-command hover:bg-command-dim text-white rounded-md"
          >
            <Plus size={13} />
            Add Source
          </button>
          <button
            type="button"
            onClick={() => load(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 border border-line rounded-md hover:bg-panel-raised disabled:opacity-50"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2.5 p-3 mt-4 mb-2 rounded-lg border border-signal-red/30 bg-signal-red/10 text-signal-red">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p className="text-[11px]">{error}</p>
        </div>
      )}

      {/* Stat tiles -- a fast operational read before drilling into any one
          source or camera, same summarize-first pattern as the dashboard's
          own status ticker. */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 mt-4">
        {[
          { label: 'Sources', value: stats.sources, tone: 'text-white' },
          { label: 'Cameras discovered', value: stats.total, tone: 'text-white' },
          { label: 'Mapped', value: stats.mapped, tone: 'text-signal-green' },
          { label: 'Unmapped', value: stats.unmapped, tone: 'text-signal-amber' },
          { label: 'Sources with errors', value: stats.errored, tone: stats.errored > 0 ? 'text-signal-red' : 'text-white' },
        ].map((tile) => (
          <div key={tile.label} className="border border-line rounded-lg bg-panel p-3">
            <p className={`text-lg font-bold ${tile.tone}`}>{tile.value}</p>
            <p className="text-[10px] text-slate-500 uppercase tracking-wide">{tile.label}</p>
          </div>
        ))}
      </div>

      {/* Source health cards */}
      <div className="mt-5">
        <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Source Health</h3>
        {sources.length === 0 ? (
          <p className="text-xs text-slate-600 italic">No sources configured.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
            {sources.map((source) => {
              const health = sourceHealth(source);
              const hint = errorHint(source.error_code);
              return (
                <div key={source.id} className="border border-line rounded-lg bg-panel p-3.5">
                  <div className="flex items-start justify-between gap-2 mb-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-white truncate">{source.id}</p>
                      <p className="text-[10px] text-slate-500">{source.camera_count} camera{source.camera_count === 1 ? '' : 's'}</p>
                    </div>
                    <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${health.className}`}>
                      <health.Icon size={11} />
                      {health.label}
                    </span>
                  </div>

                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] mb-3">
                    <dt className="text-slate-500">Last success</dt>
                    <dd className="text-slate-300 text-right">{timeAgo(source.last_success)}</dd>
                    <dt className="text-slate-500">Last attempt</dt>
                    <dd className="text-slate-300 text-right">{timeAgo(source.last_attempt)}</dd>
                    <dt className="text-slate-500">Next due</dt>
                    <dd className="text-slate-300 text-right">{timeUntil(source.next_due)}</dd>
                    <dt className="text-slate-500">Failures</dt>
                    <dd className={`text-right ${source.failures > 0 ? 'text-signal-amber' : 'text-slate-300'}`}>
                      {source.failures} <span className="text-slate-600">({source.total_failures} total)</span>
                    </dd>
                  </dl>

                  {hint && (
                    <div className="flex items-start gap-1.5 p-2 mb-3 rounded border border-signal-red/20 bg-signal-red/5 text-signal-red">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      <p className="text-[10px] leading-snug">
                        <span className="font-mono">{source.error_code}</span> — {hint}
                      </p>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleSync(source.id)}
                      disabled={syncingSource === source.id}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold text-command border border-command/30 bg-command/5 hover:bg-command/15 disabled:opacity-50 rounded"
                    >
                      {syncingSource === source.id ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                      Sync now
                    </button>
                    <button
                      type="button"
                      onClick={() => setSourceModal({ editingId: source.id })}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded border border-line bg-panel-raised text-slate-300 hover:text-white hover:border-slate-500"
                    >
                      <Pencil size={11} />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(source.id)}
                      disabled={deletingSource === source.id}
                      title="Disables the source -- its cameras/mappings history is kept, and re-adding the same ID later resumes it"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded border border-line bg-panel-raised text-slate-300 hover:text-signal-red hover:border-signal-red/40 disabled:opacity-50"
                    >
                      {deletingSource === source.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Unified camera inventory */}
      <div className="mt-6">
        <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
          <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
            Unified Inventory <span className="text-slate-600 normal-case font-normal">({filteredCameras.length})</span>
          </h3>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search cameras"
                className="w-44 bg-ink border border-line rounded pl-7 pr-2.5 py-1.5 text-[11px] text-white placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-command"
              />
            </div>
            <div className="relative">
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className="appearance-none bg-ink border border-line rounded pl-2.5 pr-7 py-1.5 text-[11px] text-white focus:outline-none focus:ring-1 focus:ring-command"
              >
                <option value="all">All sources</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>{s.id}</option>
                ))}
              </select>
              <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            </div>
            <div className="relative">
              <select
                value={mappedFilter}
                onChange={(e) => setMappedFilter(e.target.value as typeof mappedFilter)}
                className="appearance-none bg-ink border border-line rounded pl-2.5 pr-7 py-1.5 text-[11px] text-white focus:outline-none focus:ring-1 focus:ring-command"
              >
                <option value="all">Mapped + unmapped</option>
                <option value="mapped">Mapped only</option>
                <option value="unmapped">Unmapped only</option>
              </select>
              <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            </div>
          </div>
        </div>

        {cameras.length === 0 ? (
          <div className="border border-dashed border-line rounded-lg p-6 text-center">
            <Video size={20} className="mx-auto text-slate-600 mb-2" />
            <p className="text-xs text-slate-400">No cameras discovered yet.</p>
            <p className="text-[11px] text-slate-600 mt-1">
              Sources sync automatically on their own schedule -- use &quot;Sync now&quot; above to retry immediately once a source is reachable.
            </p>
          </div>
        ) : filteredCameras.length === 0 ? (
          <p className="text-xs text-slate-600 italic py-4">No cameras match the current filters.</p>
        ) : (
          <div className="border border-line rounded-lg divide-y divide-line overflow-hidden">
            {filteredCameras.map((camera) => (
              <div key={camera.id} className="p-3">
                <div className="flex items-center gap-3">
                  <span className="shrink-0 inline-flex p-1.5 rounded bg-panel-raised text-slate-400">
                    <Video size={13} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-medium text-white truncate">{camera.name}</p>
                      {camera.stale && (
                        <span className="shrink-0 text-[9px] font-semibold px-1.5 py-0.5 rounded-full border border-signal-amber/30 bg-signal-amber/10 text-signal-amber">
                          STALE
                        </span>
                      )}
                      {camera.representative && (
                        <span
                          title="Pre-recorded replay footage, not a live capture"
                          className="shrink-0 text-[9px] font-semibold px-1.5 py-0.5 rounded-full border border-signal-amber/30 bg-signal-amber/10 text-signal-amber"
                        >
                          REPLAY FOOTAGE
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-slate-500 truncate">
                      {camera.source_id} · {camera.external_id}
                      {!camera.playback_url && ' · no playback URL'}
                    </p>
                  </div>

                  <div className="shrink-0 flex items-center gap-2">
                    {camera.registry_camera_id != null ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full border border-signal-green/30 bg-signal-green/10 text-signal-green">
                        <CheckCircle2 size={11} />
                        Mapped #{camera.registry_camera_id}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setMappingCameraId(mappingCameraId === camera.id ? null : camera.id)}
                        className="inline-flex items-center gap-1 text-[10px] font-semibold px-2.5 py-1 rounded-full border border-line text-slate-300 hover:border-command/40 hover:text-command"
                      >
                        <Link2 size={11} />
                        Map to registry camera
                      </button>
                    )}
                    {camera.playback_url ? (
                      <a
                        href={camera.playback_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded border border-line text-slate-400 hover:text-white hover:border-slate-500"
                      >
                        <MapPin size={11} />
                        Open feed
                      </a>
                    ) : (
                      <span
                        title="No playback URL configured for this camera"
                        className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded border border-line text-slate-700"
                      >
                        <Ban size={11} />
                        No feed
                      </span>
                    )}
                  </div>
                </div>

                {mappingCameraId === camera.id && (
                  <MappingPicker
                    camera={camera}
                    onClose={() => setMappingCameraId(null)}
                    onMapped={() => {
                      setMappingCameraId(null);
                      load(true);
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {sourceModal && (
        <SourceFormModal
          editingId={sourceModal.editingId}
          onClose={() => setSourceModal(null)}
          onSaved={() => {
            setSourceModal(null);
            load(true);
          }}
        />
      )}
    </section>
  );
}
