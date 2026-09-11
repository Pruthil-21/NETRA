'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  X, UploadCloud, Plus, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight,
  MapPin, Keyboard, Radio, Loader2, Download, HelpCircle,
} from 'lucide-react';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { OrganizerCamera } from '@/types/organizerCamera';
import { parseCameraCsv, parseCameraJson, buildSampleCsv, buildSampleJson } from '@/lib/manualCameras';
import { areasService, Area } from '@/services/areasService';
import { federationService, FederationCamera } from '@/services/federationService';
import { cameraService } from '@/services/cameraService';

const LocationPickerMap = dynamic(() => import('./LocationPickerMap'), {
  ssr: false,
  loading: () => (
    <div className="h-48 w-full rounded border border-line bg-ink flex items-center justify-center text-xs text-slate-600">
      Loading map…
    </div>
  ),
});

type Tab = 'single' | 'bulk';
type LocationMethod = 'manual' | 'map';
type VideoChoice = 'have-it' | 'later';
type TestStatus = 'idle' | 'testing' | 'ok' | 'fail';

const emptyForm: OrganizerCamera = {
  id: '',
  name: '',
  location: '',
  status: '',
  rtsp_url: '',
  stream_path: undefined,
  hls_url: undefined,
  areaId: undefined,
};

// Loose bounding box, not a precise border check -- just enough to catch a
// stray digit or swapped lat/long before it lands on the map on the wrong
// side of the country. A camera right at the state line shouldn't be hard
// blocked, so this only ever warns, never prevents saving.
const GUJARAT_LAT_RANGE: [number, number] = [19.5, 24.8];
const GUJARAT_LONG_RANGE: [number, number] = [68, 74.8];

/** Small "?" hint button -- plain-English one-liner on hover/focus instead of
 * relying on placeholder text, which vanishes the moment a field is filled
 * in and can't be recalled without clearing it. */
function FieldHint({ text }: { text: string }) {
  return (
    <button
      type="button"
      title={text}
      tabIndex={0}
      className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-slate-600 text-slate-500 text-[9px] ml-1 cursor-help hover:border-command hover:text-command align-middle"
    >
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">?</span>
    </button>
  );
}

function downloadTextFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AddCameraModal({ onClose }: { onClose: () => void }) {
  const { addCamera, importCameras } = useCameraRegistry();
  const [tab, setTab] = useState<Tab>('single');

  // --- Single camera form ---
  const [form, setForm] = useState<OrganizerCamera>(emptyForm);
  const [added, setAdded] = useState(false);
  const [areas, setAreas] = useState<Area[]>([]);
  const [areaSearch, setAreaSearch] = useState('');
  const [areaDropdownOpen, setAreaDropdownOpen] = useState(false);
  const areaPickerRef = useRef<HTMLDivElement>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [locationMethod, setLocationMethod] = useState<LocationMethod>('manual');

  const [streamingExpanded, setStreamingExpanded] = useState(false);
  const [videoChoice, setVideoChoice] = useState<VideoChoice>('have-it');
  const [videoAddress, setVideoAddress] = useState('');
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');

  const [federationCameras, setFederationCameras] = useState<FederationCamera[]>([]);

  useEffect(() => {
    areasService.listAreas().then(setAreas).catch(() => {
      // Non-fatal: the dropdown just shows no areas until this succeeds/retries.
    });
    federationService
      .listAllCameras()
      .then((all) => setFederationCameras(all.filter((c) => c.registry_camera_id == null && c.playback_url)))
      .catch(() => {
        // Non-fatal: the federation inventory service is often unavailable
        // in dev/demo environments -- the "pick from already streaming"
        // dropdown just doesn't render rather than blocking the form.
      });
  }, []);

  // Same "type to filter district + name" pattern as the Map page's area
  // filter (MapFilterControl) -- a flat list of a dozen-plus areas is
  // tedious to scan in a native <select>, typing a few letters isn't.
  const selectedArea = useMemo(() => areas.find((a) => a.id === form.areaId) ?? null, [areas, form.areaId]);
  const visibleAreas = useMemo(() => {
    const term = areaSearch.trim().toLowerCase();
    if (!term) return areas;
    return areas.filter((a) => `${a.name} ${a.district}`.toLowerCase().includes(term));
  }, [areas, areaSearch]);

  const handlePickArea = (area: Area) => {
    setForm((f) => ({ ...f, areaId: area.id }));
    setAreaSearch('');
    setAreaDropdownOpen(false);
    setSubmitError(null);
  };

  useEffect(() => {
    if (!areaDropdownOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (!areaPickerRef.current?.contains(e.target as Node)) setAreaDropdownOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAreaDropdownOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [areaDropdownOpen]);

  const handleVideoAddressChange = (value: string) => {
    setVideoAddress(value);
    setTestStatus('idle');
    const trimmed = value.trim();
    const isUrl = /^https?:\/\//i.test(trimmed);
    setForm((f) => ({
      ...f,
      hls_url: isUrl ? trimmed || undefined : undefined,
      stream_path: !isUrl ? trimmed || undefined : undefined,
    }));
  };

  const handlePickFederationCamera = (externalId: string) => {
    const cam = federationCameras.find((c) => c.external_id === externalId);
    if (!cam) return;
    handleVideoAddressChange(cam.playback_url ?? '');
    setForm((f) => ({
      ...f,
      name: f.name?.trim() ? f.name : cam.name,
      lat: f.lat ?? cam.latitude ?? undefined,
      long: f.long ?? cam.longitude ?? undefined,
    }));
  };

  const handleTestConnection = async () => {
    setTestStatus('testing');
    try {
      const result = await cameraService.testStream({ stream_id: form.stream_path, hls_url: form.hls_url });
      setTestStatus(result.reachable ? 'ok' : 'fail');
    } catch {
      setTestStatus('fail');
    }
  };

  // Live warnings for fields that are wrong the moment they're typed --
  // Area is checked separately, only at submit time, since flagging a
  // required-but-untouched field before the officer has done anything is
  // just naggy rather than helpful.
  const rtspWarning =
    form.rtsp_url?.trim() && !/^rtsp:\/\//i.test(form.rtsp_url.trim())
      ? 'RTSP addresses normally start with rtsp://'
      : null;
  const latWarning =
    form.lat != null && (form.lat < GUJARAT_LAT_RANGE[0] || form.lat > GUJARAT_LAT_RANGE[1])
      ? 'This latitude looks outside Gujarat — double-check it.'
      : null;
  const longWarning =
    form.long != null && (form.long < GUJARAT_LONG_RANGE[0] || form.long > GUJARAT_LONG_RANGE[1])
      ? 'This longitude looks outside Gujarat — double-check it.'
      : null;

  const streamingSummary = useMemo(() => {
    if (videoChoice === 'later' && !form.stream_path && !form.hls_url) return 'Not set — connect the video later';
    if (form.hls_url) return `Set — ${form.hls_url}`;
    if (form.stream_path) return `Set — stream ${form.stream_path}`;
    return 'Not set yet';
  }, [videoChoice, form.stream_path, form.hls_url]);

  const handleSingleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.areaId) {
      setSubmitError('Select an area for this camera before saving.');
      return;
    }
    setSubmitError(null);
    addCamera(videoChoice === 'later' ? { ...form, stream_path: undefined, hls_url: undefined } : form);
    setAdded(true);
    setForm(emptyForm);
    setVideoAddress('');
    setVideoChoice('have-it');
    setTestStatus('idle');
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
  const labelClass = 'flex items-center text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1';
  const warningClass = 'flex items-center gap-1 text-[10px] text-signal-amber mt-1';

  return (
    <div
      // Leaflet's own controls/popups sit at z-index up to 1000 -- anything
      // above the map has to clear that or it silently renders underneath
      // the live map layer.
      className="fixed inset-0 z-[2000] bg-black/70 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-camera-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-panel border border-line rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line sticky top-0 bg-panel z-10">
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
          <form onSubmit={handleSingleSubmit} className="p-5 space-y-4">
            <div className="flex items-start gap-2.5 bg-command/5 border border-command/20 rounded-lg px-3 py-2.5 text-[11px] text-slate-300">
              <HelpCircle size={13} className="text-command shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                <strong className="text-white">1. Name it</strong> &middot; <strong className="text-white">2. Mark its location</strong>{' '}
                &middot; <strong className="text-white">3. Paste the video address your technician gave you</strong> (or add it later).
              </p>
            </div>

            <div>
              <p className="text-[10px] font-bold tracking-wider text-slate-400 uppercase mb-2">Basics</p>
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

              <div className="mt-3">
                <label className={labelClass}>Location</label>
                <input
                  className={inputClass}
                  placeholder='e.g. "06 Timbavadi gate-Junagadh"'
                  value={form.location}
                  onChange={(e) => setForm({ ...form, location: e.target.value })}
                />
              </div>

              <div className="mt-3 relative" ref={areaPickerRef}>
                <div className={labelClass}>
                  <label htmlFor="camera-area">Area</label>
                  <FieldHint text="Which district/area group this camera is organized under -- controls where it shows up in the area tree and filters. Type to search, same as the Map page's area filter." />
                </div>
                <input
                  id="camera-area"
                  aria-label="Area"
                  autoComplete="off"
                  className={inputClass}
                  placeholder="Search area…"
                  value={areaDropdownOpen ? areaSearch : selectedArea ? `${selectedArea.district} — ${selectedArea.name}` : ''}
                  onFocus={() => {
                    setAreaDropdownOpen(true);
                    setAreaSearch('');
                  }}
                  onChange={(e) => setAreaSearch(e.target.value)}
                />
                {areaDropdownOpen && (
                  <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-ink border border-line rounded shadow-lg">
                    {visibleAreas.length === 0 ? (
                      <p className="px-2.5 py-2 text-[11px] text-slate-500">No areas match.</p>
                    ) : (
                      visibleAreas.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => handlePickArea(a)}
                          className={`w-full text-left px-2.5 py-1.5 text-xs transition-colors ${
                            form.areaId === a.id ? 'bg-command/10 text-command' : 'text-slate-200 hover:bg-panel-raised'
                          }`}
                        >
                          {a.district} — {a.name}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              <div className="mt-3">
                <div className="flex items-center justify-between mb-1">
                  <p className={labelClass + ' mb-0'}>
                    Location on map
                    <FieldHint text="Where this camera physically is. Pick a point on the map or type exact coordinates -- whichever is easier." />
                  </p>
                  <div className="flex rounded border border-line overflow-hidden shrink-0">
                    <button
                      type="button"
                      onClick={() => setLocationMethod('manual')}
                      className={`flex items-center gap-1 px-2 py-1 text-[10px] font-semibold transition ${
                        locationMethod === 'manual' ? 'bg-command text-white' : 'bg-ink text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <Keyboard size={11} />
                      Type it
                    </button>
                    <button
                      type="button"
                      onClick={() => setLocationMethod('map')}
                      className={`flex items-center gap-1 px-2 py-1 text-[10px] font-semibold transition ${
                        locationMethod === 'map' ? 'bg-command text-white' : 'bg-ink text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <MapPin size={11} />
                      Pin on map
                    </button>
                  </div>
                </div>

                {locationMethod === 'map' ? (
                  <>
                    <LocationPickerMap
                      lat={form.lat ?? null}
                      long={form.long ?? null}
                      onChange={(lat, long) => setForm((f) => ({ ...f, lat, long }))}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">
                      Click the map to drop a pin, or drag it once placed.{' '}
                      {form.lat != null && form.long != null && (
                        <span className="font-mono text-slate-400">
                          {form.lat.toFixed(5)}, {form.long.toFixed(5)}
                        </span>
                      )}
                    </p>
                  </>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <input
                        aria-label="Latitude"
                        className={`${inputClass} font-mono`}
                        placeholder="Latitude (falls back to Gujarat centroid)"
                        value={form.lat ?? ''}
                        onChange={(e) => setForm({ ...form, lat: e.target.value ? Number(e.target.value) : undefined })}
                      />
                      {latWarning && (
                        <p className={warningClass}>
                          <AlertTriangle size={10} /> {latWarning}
                        </p>
                      )}
                    </div>
                    <div>
                      <input
                        aria-label="Longitude"
                        className={`${inputClass} font-mono`}
                        placeholder="Longitude"
                        value={form.long ?? ''}
                        onChange={(e) => setForm({ ...form, long: e.target.value ? Number(e.target.value) : undefined })}
                      />
                      {longWarning && (
                        <p className={warningClass}>
                          <AlertTriangle size={10} /> {longWarning}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="border border-line rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setStreamingExpanded((v) => !v)}
                className="w-full flex items-center justify-between px-3 py-2.5 bg-panel-raised/40 hover:bg-panel-raised text-left"
              >
                <span className="flex items-center gap-1.5 text-xs font-semibold text-white">
                  {streamingExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  Streaming Connection
                </span>
                <span className="text-[10px] text-slate-500">{streamingSummary}</span>
              </button>

              {streamingExpanded && (
                <div className="px-3 py-3 border-t border-line space-y-3">
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    This is what actually makes the video play. Ask whoever set the camera up on the streaming
                    relay for its address.
                  </p>

                  <div className="flex rounded border border-line overflow-hidden w-fit">
                    <button
                      type="button"
                      onClick={() => setVideoChoice('have-it')}
                      className={`px-2.5 py-1.5 text-[11px] font-semibold transition ${
                        videoChoice === 'have-it' ? 'bg-command text-white' : 'bg-ink text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      I have the video address
                    </button>
                    <button
                      type="button"
                      onClick={() => setVideoChoice('later')}
                      className={`px-2.5 py-1.5 text-[11px] font-semibold transition ${
                        videoChoice === 'later' ? 'bg-command text-white' : 'bg-ink text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Add now, connect later
                    </button>
                  </div>

                  {videoChoice === 'later' ? (
                    <p className="flex items-start gap-1.5 text-[11px] text-slate-400 bg-panel-raised/50 rounded p-2.5">
                      <CheckCircle2 size={12} className="text-signal-green shrink-0 mt-0.5" />
                      No problem — the camera is added to the registry and map now, with no live feed to show
                      until you edit it later with a video address.
                    </p>
                  ) : (
                    <>
                      {federationCameras.length > 0 && (
                        <div>
                          <div className={labelClass}>
                            <label htmlFor="camera-pick-federation">Pick from cameras already streaming</label>
                            <FieldHint text="Cameras the streaming relay already knows about but aren't registered yet -- picking one fills in its address, name, and location for you." />
                          </div>
                          <select
                            id="camera-pick-federation"
                            className={inputClass}
                            defaultValue=""
                            onChange={(e) => e.target.value && handlePickFederationCamera(e.target.value)}
                          >
                            <option value="">Choose one…</option>
                            {federationCameras.map((c) => (
                              <option key={c.external_id} value={c.external_id}>
                                {c.name} ({c.source_id})
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      <div>
                        <div className={labelClass}>
                          <label htmlFor="camera-video-address">Video Feed Address</label>
                          <FieldHint text="Paste either the short stream ID/path or the full HLS link your technician gave you -- either works, this figures out which one it is." />
                        </div>
                        <div className="flex gap-2">
                          <input
                            id="camera-video-address"
                            className={`${inputClass} font-mono`}
                            placeholder="e.g. 12, xiaomi-camera, or a full https:// link"
                            value={videoAddress}
                            onChange={(e) => handleVideoAddressChange(e.target.value)}
                          />
                          <button
                            type="button"
                            onClick={handleTestConnection}
                            disabled={!videoAddress.trim() || testStatus === 'testing'}
                            className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold rounded border border-line bg-panel-raised text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                          >
                            {testStatus === 'testing' ? <Loader2 size={12} className="animate-spin" /> : <Radio size={12} />}
                            Test
                          </button>
                        </div>
                        {testStatus === 'ok' && (
                          <p className="flex items-center gap-1 text-[10px] text-signal-green mt-1">
                            <CheckCircle2 size={10} /> Reachable — this feed is live right now.
                          </p>
                        )}
                        {testStatus === 'fail' && (
                          <p className="flex items-center gap-1 text-[10px] text-signal-red mt-1">
                            <AlertTriangle size={10} /> Can&apos;t reach this feed — double-check it with your technician.
                          </p>
                        )}
                      </div>

                      <div>
                        <div className={labelClass}>
                          <label htmlFor="camera-rtsp-url">RTSP URL (optional)</label>
                          <FieldHint text="The camera's raw address, kept for the record only -- a browser can't play RTSP directly, so this doesn't affect whether the feed shows up here." />
                        </div>
                        <input
                          id="camera-rtsp-url"
                          className={`${inputClass} font-mono`}
                          placeholder="rtsp://..."
                          value={form.rtsp_url}
                          onChange={(e) => setForm({ ...form, rtsp_url: e.target.value })}
                        />
                        {rtspWarning && (
                          <p className={warningClass}>
                            <AlertTriangle size={10} /> {rtspWarning}
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {submitError && (
              <p className="flex items-center gap-1.5 text-[11px] text-signal-red">
                <AlertTriangle size={12} /> {submitError}
              </p>
            )}

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
                <CheckCircle2 size={12} /> Added. It&apos;s now on the map and in the list.
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

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => downloadTextFile('camera-import-sample.csv', buildSampleCsv(), 'text/csv')}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold rounded border border-line bg-panel-raised text-slate-300 hover:text-white hover:border-slate-500 transition-colors"
              >
                <Download size={12} />
                Download sample CSV
              </button>
              <button
                type="button"
                onClick={() => downloadTextFile('camera-import-sample.json', buildSampleJson(), 'application/json')}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold rounded border border-line bg-panel-raised text-slate-300 hover:text-white hover:border-slate-500 transition-colors"
              >
                <Download size={12} />
                Download sample JSON
              </button>
            </div>

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
