'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Upload, X, AlertTriangle } from 'lucide-react';
import { SearchSelect } from '@/components/common/SearchSelect';
import { locationsService, District } from '@/services/locationsService';
import { usePermissions } from '@/hooks/usePermissions';
import { anprJobsService } from '@/services/anprJobsService';

interface UploadTabProps {
  kind: 'video' | 'image';
  onSubmitted: (jobId: number) => void;
}

// Matches backend-watchlist's ANPR_MAX_VIDEO_BYTES/ANPR_MAX_IMAGE_BYTES
// defaults -- a client-side pre-check for fast feedback, never the only
// check (the server re-validates size and sniffs actual file content
// regardless of what's declared here).
const MAX_BYTES: Record<UploadTabProps['kind'], number> = {
  video: 200 * 1024 * 1024,
  image: 15 * 1024 * 1024,
};
const ACCEPT: Record<UploadTabProps['kind'], string> = {
  video: 'video/mp4,video/webm',
  image: 'image/jpeg,image/png',
};

export function UploadTab({ kind, onSubmitted }: UploadTabProps) {
  const { scopeValue } = usePermissions();
  const [districts, setDistricts] = useState<District[]>([]);
  const [selectedDistrict, setSelectedDistrict] = useState<District | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [recordedAt, setRecordedAt] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    locationsService.listDistricts().then(setDistricts).catch(() => setDistricts([]));
  }, []);

  // Pre-select the officer's own district when they're district-scoped --
  // still changeable (a platform-wide submission for another district is a
  // real, if less common, need), but saves the common case a click.
  useEffect(() => {
    if (!scopeValue || districts.length === 0 || selectedDistrict) return;
    const match = districts.find((d) => d.name === scopeValue);
    if (match) setSelectedDistrict(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeValue, districts]);

  const validateAndSetFile = (candidate: File) => {
    setError(null);
    const expectedPrefix = kind === 'video' ? 'video/' : 'image/';
    if (!candidate.type.startsWith(expectedPrefix)) {
      setError(`Expected a${kind === 'video' ? '' : 'n'} ${kind} file, got "${candidate.type || 'unknown type'}"`);
      return;
    }
    if (candidate.size > MAX_BYTES[kind]) {
      setError(`File is too large -- limit is ${Math.round(MAX_BYTES[kind] / (1024 * 1024))}MB for ${kind}s.`);
      return;
    }
    setFile(candidate);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) validateAndSetFile(dropped);
  };

  const handleSubmit = async () => {
    if (!file || !selectedDistrict) return;
    setError(null);
    setProgress(0);
    try {
      const job = await anprJobsService.submitUpload(
        {
          inputType: kind === 'video' ? 'upload_video' : 'upload_image',
          district: selectedDistrict.name,
          file,
          ...(kind === 'video' && recordedAt ? { recordedAt: new Date(recordedAt).toISOString() } : {}),
        },
        setProgress
      );
      setFile(null);
      setRecordedAt('');
      setProgress(null);
      onSubmitted(job.id);
    } catch (err) {
      setProgress(null);
      setError(err instanceof Error ? err.message : 'Failed to submit upload');
    }
  };

  return (
    <div className="space-y-4 max-w-md">
      <div>
        <SearchSelect<District>
          id={`plate-lookup-district-${kind}`}
          label="District"
          items={districts}
          getKey={(d) => d.id}
          getLabel={(d) => d.name}
          value={selectedDistrict}
          onChange={setSelectedDistrict}
          placeholder="Select a district…"
          emptyMessage="No matching district."
        />
      </div>

      <div>
        <label className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1">
          {kind === 'video' ? 'Video Clip' : 'Photo'}
        </label>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT[kind]}
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = '';
            if (picked) validateAndSetFile(picked);
          }}
        />
        {file ? (
          <div className="flex items-center gap-2 bg-ink border border-line rounded px-3 py-2">
            <span className="flex-1 min-w-0 truncate text-xs text-slate-300">{file.name}</span>
            <span className="text-[10px] text-slate-500 shrink-0">{Math.round(file.size / 1024)} KB</span>
            <button
              type="button"
              onClick={() => setFile(null)}
              aria-label="Remove selected file"
              className="text-slate-500 hover:text-white p-0.5 shrink-0"
            >
              <X size={13} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`flex flex-col items-center justify-center gap-2 w-full py-8 rounded border border-dashed text-xs transition ${
              dragOver ? 'border-command text-command bg-command/5' : 'border-line text-slate-500 hover:text-white hover:border-command'
            }`}
          >
            <Upload size={20} />
            Drag a {kind} here, or click to choose a file
          </button>
        )}
      </div>

      {kind === 'video' && (
        <div>
          <label
            className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1"
            htmlFor="recorded-at"
          >
            When Was This Recorded? (Optional)
          </label>
          <input
            id="recorded-at"
            type="datetime-local"
            value={recordedAt}
            onChange={(e) => setRecordedAt(e.target.value)}
            className="w-full bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
          />
          <p className="text-[10px] text-slate-600 mt-1">
            Lets us show the real moment each plate was seen in this clip. Leave blank if unknown --
            plates found will still show up, just without a timestamp.
          </p>
        </div>
      )}

      {progress !== null && (
        <div className="space-y-1">
          <div className="h-1.5 bg-panel-raised rounded-full overflow-hidden">
            <div className="h-full bg-command transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="text-[10px] text-slate-500">Uploading… {Math.round(progress * 100)}%</p>
        </div>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-[11px] text-signal-red">
          <AlertTriangle size={12} /> {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!file || !selectedDistrict || progress !== null}
        className="w-full bg-command hover:bg-command-dim text-white font-semibold py-2.5 rounded-md text-xs uppercase tracking-wider transition disabled:opacity-50"
      >
        {progress !== null ? 'Submitting…' : 'Submit for Plate Lookup'}
      </button>
    </div>
  );
}
