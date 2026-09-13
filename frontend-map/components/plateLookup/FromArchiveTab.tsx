'use client';

import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { SearchSelect } from '@/components/common/SearchSelect';
import { useCameraRegistry } from '@/context/CameraRegistryContext';
import { Camera } from '@/types/camera';
import { anprJobsService } from '@/services/anprJobsService';

interface FromArchiveTabProps {
  onSubmitted: (jobId: number) => void;
}

/** Camera + timestamp-range entry -- deliberately direct-entry (two
 * datetime-local inputs, same convention VehicleSearchPanel's own date
 * range already uses) rather than re-embedding Archive's full scrubber/
 * calendar/player UI here, which would pull a large chunk of that page's
 * machinery into a lookup submission form for the same end result: a
 * camera id + a start/end instant. The backend re-resolves a fresh,
 * short-lived clip URL from the recording service right before dispatch
 * (see anpr_jobs_service.dispatch_to_ml_anpr) -- nothing here ever handles
 * a playback URL or its 15-minute token directly. */
export function FromArchiveTab({ onSubmitted }: FromArchiveTabProps) {
  const { cameras } = useCameraRegistry();
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    if (!selectedCamera) {
      setError('Select a camera.');
      return;
    }
    if (!start || !end) {
      setError('Enter both a start and end time.');
      return;
    }
    const startIso = new Date(start).toISOString();
    const endIso = new Date(end).toISOString();
    if (endIso <= startIso) {
      setError('End time must be after start time.');
      return;
    }
    setSubmitting(true);
    try {
      const job = await anprJobsService.submitArchiveClip({
        sourceCameraId: selectedCamera.id, clipStart: startIso, clipEnd: endIso,
      });
      setStart('');
      setEnd('');
      onSubmitted(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit archive clip');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 max-w-md">
      <div>
        <SearchSelect<Camera>
          id="plate-lookup-archive-camera"
          label="Camera"
          items={cameras}
          getKey={(c) => c.id}
          getLabel={(c) => `${c.name} (${c.dept})`}
          value={selectedCamera}
          onChange={setSelectedCamera}
          placeholder="Select a camera…"
          emptyMessage="No matching camera."
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1" htmlFor="clip-start">
            Start
          </label>
          <input
            id="clip-start"
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-full bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
          />
        </div>
        <div>
          <label className="block text-[10px] font-semibold tracking-wider text-slate-400 uppercase mb-1" htmlFor="clip-end">
            End
          </label>
          <input
            id="clip-end"
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="w-full bg-ink border border-line rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-command"
          />
        </div>
      </div>

      {error && (
        <p className="flex items-center gap-1.5 text-[11px] text-signal-red">
          <AlertTriangle size={12} /> {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full bg-command hover:bg-command-dim text-white font-semibold py-2.5 rounded-md text-xs uppercase tracking-wider transition disabled:opacity-50"
      >
        {submitting ? 'Submitting…' : 'Submit for Plate Lookup'}
      </button>
    </div>
  );
}
