'use client';

import React, { useState, useRef } from 'react';
import { X, UploadCloud, Plus, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { OrganizerCamera } from '@/types/organizerCamera';
import { parseCameraCsv, parseCameraJson } from '@/lib/manualCameras';

type Tab = 'single' | 'bulk';

const emptyForm: OrganizerCamera = { id: '', name: '', location: '', status: '', rtsp_url: '', stream_path: undefined, hls_url: undefined };

export default function AddCameraModal({ onClose }: { onClose: () => void }) {
  const { addCamera, importCameras } = useCameraRegistry();
  const [tab, setTab] = useState<Tab>('single');

  // --- Single camera form ---
  const [form, setForm] = useState<OrganizerCamera>(emptyForm);
  const [added, setAdded] = useState(false);

  const handleSingleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    addCamera(form);
    setAdded(true);
    setForm(emptyForm);
    setTimeout(() => setAdded(false), 2500);
  };

  // --- Bulk import ---
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingRows, setPendingRows] = useState<OrganizerCamera[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [fileName, setFileName] = useState('');
  const [imported, setImported] = useState(0);

  const handleFile = async (file: File) => {
    const text = await file.text();
    const result = file.name.toLowerCase().endsWith('.json') ? parseCameraJson(text) : parseCameraCsv(text);
    setPendingRows(result.rows);
    setParseErrors(result.errors);
    setFileName(file.name);
    setImported(0);
  };

  const handleImportConfirm = () => {
    importCameras(pendingRows);
    setImported(pendingRows.length);
    setPendingRows([]);
    setFileName('');
  };

  const inputClass =
    'w-full bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-command focus:border-command transition';
  const labelClass = 'block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1';

  return (
    <div
      // Leaflet's own controls/panes (zoom buttons, popups) sit at z-index up
      // to 1000 — anything above the map has to clear that or it silently
      // renders underneath the live map layer.
      className="fixed inset-0 z-[2000] bg-black/70 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-camera-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-panel border border-line rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 id="add-camera-title" className="text-sm font-semibold text-white tracking-wide">
            Add Camera
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded hover:bg-panel-raised"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex border-b border-line px-5 gap-4 text-xs">
          {(['single', 'bulk'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`py-2.5 border-b-2 transition font-medium ${
                tab === t ? 'border-command text-white' : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
            >
              {t === 'single' ? 'Single Camera' : 'Bulk Import'}
            </button>
          ))}
        </div>

        {tab === 'single' ? (
          <form onSubmit={handleSingleSubmit} className="p-5 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Camera ID</label>
                <input
                  className={inputClass}
                  placeholder="auto-assigned if blank"
                  value={form.id}
                  onChange={(e) => setForm({ ...form, id: e.target.value })}
                />
              </div>
              <div>
                <label className={labelClass}>Name</label>
                <input
                  className={inputClass}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
            </div>
            <div>
              <label className={labelClass}>Location</label>
              <input
                className={inputClass}
                placeholder='e.g. "06 Timbavadi gate-Junagadh"'
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
              />
            </div>
            <div>
              <label className={labelClass}>RTSP URL</label>
              <input
                className={`${inputClass} font-mono`}
                placeholder="rtsp://... (for the registry record — a browser can't play this directly)"
                value={form.rtsp_url}
                onChange={(e) => setForm({ ...form, rtsp_url: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Stream ID / Path</label>
                <input
                  className={`${inputClass} font-mono`}
                  placeholder="e.g. 12 or xiaomi-camera"
                  value={form.stream_path ?? ''}
                  onChange={(e) => setForm({ ...form, stream_path: e.target.value || undefined })}
                />
              </div>
              <div>
                <label className={labelClass}>Direct HLS URL</label>
                <input
                  className={`${inputClass} font-mono`}
                  placeholder="overrides Stream ID if set"
                  value={form.hls_url ?? ''}
                  onChange={(e) => setForm({ ...form, hls_url: e.target.value || undefined })}
                />
              </div>
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Get the Stream ID/Path or HLS URL from whoever set the camera up on MediaMTX. Without one of
              these, the camera is added to the registry and the map but has no live feed to show.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Latitude (optional)</label>
                <input
                  className={`${inputClass} font-mono`}
                  placeholder="falls back to Gujarat centroid"
                  value={form.lat ?? ''}
                  onChange={(e) => setForm({ ...form, lat: e.target.value ? Number(e.target.value) : undefined })}
                />
              </div>
              <div>
                <label className={labelClass}>Longitude (optional)</label>
                <input
                  className={`${inputClass} font-mono`}
                  value={form.long ?? ''}
                  onChange={(e) => setForm({ ...form, long: e.target.value ? Number(e.target.value) : undefined })}
                />
              </div>
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Camera type, ownership, storage and retention aren&apos;t collected here — same as the organizer
              feed, they&apos;re fixed placeholders until a real registry supplies them. Live/offline status is
              whatever the stream actually does once added.
            </p>
            <button
              type="submit"
              className="w-full flex items-center justify-center gap-1.5 bg-command hover:bg-command-dim text-white text-xs font-semibold py-2 rounded transition"
            >
              <Plus size={14} />
              Add Camera
            </button>
            {added && (
              <p className="flex items-center gap-1.5 text-[11px] text-signal-green">
                <CheckCircle2 size={12} /> Added. It's now on the map and in the list.
              </p>
            )}
          </form>
        ) : (
          <div className="p-5 space-y-3">
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Upload a CSV or JSON file with columns/fields:{' '}
              <code className="font-mono text-command">id, name, location, status, width, height, rtsp_url</code>{' '}
              — <code className="font-mono text-command">lat</code>/<code className="font-mono text-command">long</code>{' '}
              and <code className="font-mono text-command">stream_path</code>/
              <code className="font-mono text-command">hls_url</code> are optional. Only{' '}
              <code className="font-mono text-command">id</code> is required per row. Rows without a stream_path or
              hls_url get added with no live feed until one is supplied.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.json"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex flex-col items-center justify-center gap-2 border border-dashed border-line rounded-lg py-8 text-slate-400 hover:border-command hover:text-command transition"
            >
              <UploadCloud size={22} />
              <span className="text-xs">{fileName || 'Click to choose a .csv or .json file'}</span>
            </button>

            {parseErrors.length > 0 && (
              <div className="bg-signal-red/10 border border-signal-red/40 rounded p-2.5 text-[11px] text-signal-red space-y-1 max-h-24 overflow-y-auto">
                <p className="flex items-center gap-1.5 font-semibold">
                  <AlertTriangle size={12} /> {parseErrors.length} row(s) skipped
                </p>
                {parseErrors.map((err, i) => (
                  <p key={i} className="font-mono">
                    {err}
                  </p>
                ))}
              </div>
            )}

            {pendingRows.length > 0 && (
              <div className="flex items-center justify-between bg-panel-raised border border-line rounded p-3">
                <p className="text-xs text-slate-300">
                  <strong className="text-white font-mono">{pendingRows.length}</strong> camera(s) ready to import
                </p>
                <button
                  type="button"
                  onClick={handleImportConfirm}
                  className="bg-command hover:bg-command-dim text-white text-[11px] font-semibold px-3 py-1.5 rounded transition"
                >
                  Confirm Import
                </button>
              </div>
            )}

            {imported > 0 && (
              <p className="flex items-center gap-1.5 text-[11px] text-signal-green">
                <CheckCircle2 size={12} /> Imported {imported} camera(s). They&apos;re now on the map and in the list.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
