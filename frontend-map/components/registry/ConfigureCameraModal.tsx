'use client';

import React, { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { X, AlertTriangle, Loader2, MapPin } from 'lucide-react';
import { Camera, CameraType, StorageType } from '@/types/camera';
import { Area } from '@/services/areasService';
import { cameraService } from '@/services/cameraService';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { usePermissions } from '@/hooks/usePermissions';

const LocationPickerMap = dynamic(() => import('./LocationPickerMap'), {
  ssr: false,
  loading: () => (
    <div className="h-48 w-full rounded border border-line bg-ink flex items-center justify-center text-xs text-slate-600">
      Loading map…
    </div>
  ),
});

const CAMERA_TYPES: CameraType[] = ['PTZ', 'Dome', 'Bullet', 'ANPR'];
const STORAGE_TYPES: StorageType[] = ['Local', 'Cloud', 'Hybrid'];

// Same loose bounding box as AddCameraModal -- a warning, never a hard block,
// since a camera right at the state line is legitimate.
const GUJARAT_LAT_RANGE: [number, number] = [19.5, 24.8];
const GUJARAT_LONG_RANGE: [number, number] = [68, 74.8];

interface ConfigureFormState {
  name: string;
  dept: string;
  area_id: number | null;
  lat: number;
  long: number;
  camera_type: CameraType;
  ownership: string;
  storage_type: StorageType;
  retention_days: number;
  rtsp_url: string;
  stream_id: string;
  hls_url: string;
}

function toForm(camera: Camera): ConfigureFormState {
  return {
    name: camera.name,
    dept: camera.dept,
    area_id: camera.area_id ?? null,
    lat: camera.lat,
    long: camera.long,
    camera_type: camera.camera_type,
    ownership: camera.ownership,
    storage_type: camera.storage_type,
    retention_days: camera.retention_days,
    rtsp_url: camera.rtsp_url ?? '',
    stream_id: camera.stream_id != null ? String(camera.stream_id) : '',
    hls_url: camera.hls_url ?? '',
  };
}

/** Every field this camera was created with, editable in one place --
 * "Configure…" from the right-click menu. Same field set as Add Camera's
 * single-camera form, just against the real Camera type/PUT /cameras/{id}
 * instead of the manual/organizer path AddCameraModal writes to. Only the
 * fields an officer actually changed are sent, so an unrelated concurrent
 * edit (e.g. the health poller flipping connectivity_status) is never
 * clobbered by a stale round-trip of every field. */
export default function ConfigureCameraModal({
  camera,
  districts,
  areas,
  onClose,
}: {
  camera: Camera;
  districts: string[];
  areas: Area[];
  onClose: () => void;
}) {
  const { applyCameraUpdate } = useCameraRegistry();
  const { scopeType } = usePermissions();
  // A district-scoped officer's own PUT is rejected server-side the moment
  // `dept` would change (rbac_scope.py's guard_dept_in_scope) -- moving a
  // camera across a jurisdiction boundary is a platform-level call in the
  // real hierarchy too (an SP doesn't unilaterally reparent an asset into
  // another SP's district). Locking the field here just surfaces that
  // constraint up front instead of letting the officer discover it via a
  // failed save.
  const districtLocked = scopeType === 'district';
  const [form, setForm] = useState<ConfigureFormState>(() => toForm(camera));
  const [showMapPicker, setShowMapPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const districtAreas = useMemo(() => areas.filter((a) => a.district === form.dept), [areas, form.dept]);

  const inputClass =
    'w-full bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition';
  const labelClass = 'flex items-center text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1';
  const warningClass = 'flex items-center gap-1 text-[10px] text-signal-amber mt-1';

  const latWarning =
    form.lat < GUJARAT_LAT_RANGE[0] || form.lat > GUJARAT_LAT_RANGE[1]
      ? 'This latitude looks outside Gujarat — double-check it.'
      : null;
  const longWarning =
    form.long < GUJARAT_LONG_RANGE[0] || form.long > GUJARAT_LONG_RANGE[1]
      ? 'This longitude looks outside Gujarat — double-check it.'
      : null;
  const rtspWarning =
    form.rtsp_url.trim() && !/^rtsp:\/\//i.test(form.rtsp_url.trim())
      ? 'RTSP addresses normally start with rtsp://'
      : null;

  const handleDistrictChange = (dept: string) => {
    const stillValid = areas.some((a) => a.district === dept && a.id === form.area_id);
    setForm((f) => ({ ...f, dept, area_id: stillValid ? f.area_id : null }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('Name can\'t be blank.');
      return;
    }
    setError(null);
    setSaving(true);

    // Only the changed fields go over the wire -- see the doc comment above.
    const original = toForm(camera);
    const patch: Partial<Omit<Camera, 'id'>> = {};
    if (form.name.trim() !== original.name) patch.name = form.name.trim();
    if (form.dept !== original.dept) patch.dept = form.dept;
    if (form.area_id !== original.area_id) patch.area_id = form.area_id;
    if (form.lat !== original.lat) patch.lat = form.lat;
    if (form.long !== original.long) patch.long = form.long;
    if (form.camera_type !== original.camera_type) patch.camera_type = form.camera_type;
    if (form.ownership.trim() !== original.ownership) patch.ownership = form.ownership.trim();
    if (form.storage_type !== original.storage_type) patch.storage_type = form.storage_type;
    if (form.retention_days !== original.retention_days) patch.retention_days = form.retention_days;
    if (form.rtsp_url.trim() !== original.rtsp_url) patch.rtsp_url = form.rtsp_url.trim() || undefined;
    if (form.stream_id.trim() !== original.stream_id) patch.stream_id = form.stream_id.trim() || undefined;
    if (form.hls_url.trim() !== original.hls_url) patch.hls_url = form.hls_url.trim() || undefined;

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    try {
      await cameraService.updateCamera(camera.id, patch);
      applyCameraUpdate(camera.id, patch);
      setSaved(true);
      setTimeout(onClose, 700);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[2000] bg-black/70 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="configure-camera-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-panel border border-line rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line sticky top-0 bg-panel z-10">
          <h2 id="configure-camera-title" className="text-sm font-semibold text-white tracking-wide truncate">
            Configure — {camera.name}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded hover:bg-panel-raised shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <p className="text-[10px] font-bold tracking-wider text-slate-400 uppercase mb-2">Basics</p>
            <div>
              <label className={labelClass} htmlFor="configure-name">Name</label>
              <input
                id="configure-name"
                className={inputClass}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <label className={labelClass} htmlFor="configure-district">District</label>
                <select
                  id="configure-district"
                  value={form.dept}
                  onChange={(e) => handleDistrictChange(e.target.value)}
                  disabled={districtLocked}
                  title={districtLocked ? 'Reassigning a camera across districts requires platform-level authority' : undefined}
                  className={`${inputClass} disabled:opacity-60 disabled:cursor-not-allowed`}
                >
                  {!districts.includes(form.dept) && <option value={form.dept}>{form.dept}</option>}
                  {districts.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
                {districtLocked && (
                  <p className="text-[10px] text-slate-500 mt-1">
                    Reassigning across districts requires platform-level authority.
                  </p>
                )}
              </div>
              <div>
                <label className={labelClass} htmlFor="configure-area">Area</label>
                <select
                  id="configure-area"
                  value={form.area_id ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, area_id: e.target.value === '' ? null : Number(e.target.value) }))}
                  className={inputClass}
                >
                  <option value="">Unassigned</option>
                  {districtAreas.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-bold tracking-wider text-slate-400 uppercase">Location</p>
              <button
                type="button"
                onClick={() => setShowMapPicker((v) => !v)}
                className="flex items-center gap-1 text-[10px] text-command hover:underline"
              >
                <MapPin size={11} />
                {showMapPicker ? 'Hide map' : 'Pick on map'}
              </button>
            </div>
            {showMapPicker && (
              <div className="mb-3">
                <LocationPickerMap
                  lat={form.lat}
                  long={form.long}
                  onChange={(lat, long) => setForm((f) => ({ ...f, lat, long }))}
                />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass} htmlFor="configure-lat">Latitude</label>
                <input
                  id="configure-lat"
                  type="number"
                  step="any"
                  className={inputClass}
                  value={form.lat}
                  onChange={(e) => setForm((f) => ({ ...f, lat: Number(e.target.value) }))}
                />
                {latWarning && <p className={warningClass}><AlertTriangle size={10} />{latWarning}</p>}
              </div>
              <div>
                <label className={labelClass} htmlFor="configure-long">Longitude</label>
                <input
                  id="configure-long"
                  type="number"
                  step="any"
                  className={inputClass}
                  value={form.long}
                  onChange={(e) => setForm((f) => ({ ...f, long: Number(e.target.value) }))}
                />
                {longWarning && <p className={warningClass}><AlertTriangle size={10} />{longWarning}</p>}
              </div>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-bold tracking-wider text-slate-400 uppercase mb-2">Device</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass} htmlFor="configure-camera-type">Camera Type</label>
                <select
                  id="configure-camera-type"
                  value={form.camera_type}
                  onChange={(e) => setForm((f) => ({ ...f, camera_type: e.target.value as CameraType }))}
                  className={inputClass}
                >
                  {CAMERA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor="configure-ownership">Ownership</label>
                <input
                  id="configure-ownership"
                  className={inputClass}
                  placeholder="e.g. Anand Police"
                  value={form.ownership}
                  onChange={(e) => setForm((f) => ({ ...f, ownership: e.target.value }))}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="configure-storage-type">Storage Type</label>
                <select
                  id="configure-storage-type"
                  value={form.storage_type}
                  onChange={(e) => setForm((f) => ({ ...f, storage_type: e.target.value as StorageType }))}
                  className={inputClass}
                >
                  {STORAGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor="configure-retention">Retention (Days)</label>
                <input
                  id="configure-retention"
                  type="number"
                  min={0}
                  className={inputClass}
                  value={form.retention_days}
                  onChange={(e) => setForm((f) => ({ ...f, retention_days: Number(e.target.value) }))}
                />
              </div>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-bold tracking-wider text-slate-400 uppercase mb-2">Video Source</p>
            <div className="space-y-3">
              <div>
                <label className={labelClass} htmlFor="configure-rtsp">RTSP URL</label>
                <input
                  id="configure-rtsp"
                  className={inputClass}
                  placeholder="rtsp://…"
                  value={form.rtsp_url}
                  onChange={(e) => setForm((f) => ({ ...f, rtsp_url: e.target.value }))}
                />
                {rtspWarning && <p className={warningClass}><AlertTriangle size={10} />{rtspWarning}</p>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass} htmlFor="configure-stream-id">Stream ID</label>
                  <input
                    id="configure-stream-id"
                    className={inputClass}
                    placeholder="e.g. 12 or pruthil-phone"
                    value={form.stream_id}
                    onChange={(e) => setForm((f) => ({ ...f, stream_id: e.target.value }))}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="configure-hls-url">HLS URL</label>
                  <input
                    id="configure-hls-url"
                    className={inputClass}
                    placeholder="https://…/index.m3u8"
                    value={form.hls_url}
                    onChange={(e) => setForm((f) => ({ ...f, hls_url: e.target.value }))}
                  />
                </div>
              </div>
            </div>
          </div>

          {error && (
            <p className="flex items-center gap-1.5 text-[11px] text-signal-red">
              <AlertTriangle size={12} className="shrink-0" />
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded text-slate-400 hover:text-white hover:bg-panel-raised"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-3.5 py-1.5 text-xs rounded bg-command text-white hover:bg-command/90 disabled:opacity-50 flex items-center gap-1.5"
            >
              {saving && <Loader2 size={12} className="animate-spin" />}
              {saved ? 'Saved' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
