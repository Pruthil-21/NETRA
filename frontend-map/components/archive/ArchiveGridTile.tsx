'use client';

import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Camera } from '@/types/camera';
import { fetchRecordingSegments, RecordingSegment } from '@/services/recordingsService';
import { RecordingPlayer } from './RecordingPlayer';
import { toLocalDateKey } from './RecordingCalendar';

interface ArchiveGridTileProps {
  camera: Camera;
  onRemove: (cameraId: number) => void;
}

/** One camera's recorded footage inside Archive's drag-composed multi-camera
 * grid (see app/archive/page.tsx) -- deliberately self-contained: its own
 * day picker, its own segment fetch, its own RecordingPlayer, so each tile
 * in the grid can be scrubbing a completely different day independently of
 * every other tile. A plain native date input rather than the full
 * RecordingCalendar widget -- that's sized for "the only thing on the page",
 * too wide for one cell in a grid of several. */
export function ArchiveGridTile({ camera, onRemove }: ArchiveGridTileProps) {
  const [selectedDate, setSelectedDate] = useState(() => toLocalDateKey(new Date()));
  const [segments, setSegments] = useState<RecordingSegment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSegments(null);
    setError(null);
    const dayStart = new Date(`${selectedDate}T00:00:00`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    fetchRecordingSegments(camera.id, { start: dayStart.toISOString(), end: dayEnd.toISOString() })
      .then((result) => {
        if (!cancelled) setSegments(result.segments);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load recordings');
      });
    return () => {
      cancelled = true;
    };
  }, [camera.id, selectedDate]);

  return (
    <div className="bg-panel border border-line rounded-lg overflow-hidden flex flex-col min-w-0">
      <div className="p-2.5 border-b border-line flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-xs text-white truncate">{camera.name}</p>
          <p className="text-[10px] text-slate-500 truncate">{camera.dept}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <input
            type="date"
            aria-label={`Pick a day for ${camera.name}`}
            value={selectedDate}
            max={toLocalDateKey(new Date())}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="bg-ink border border-line rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none focus:ring-1 focus:ring-command"
          />
          <button
            type="button"
            onClick={() => onRemove(camera.id)}
            aria-label={`Remove ${camera.name} from the grid`}
            title="Remove from grid"
            className="p-1 rounded bg-panel-raised text-slate-400 hover:bg-red-950 hover:text-red-300"
          >
            <X size={12} />
          </button>
        </div>
      </div>
      <div className="p-2.5">
        {error && <p className="text-[11px] text-signal-red">{error}</p>}
        {!error && segments === null && <p className="text-[11px] text-slate-500">Loading…</p>}
        {!error && segments !== null && (
          <RecordingPlayer cameraId={camera.id} cameraName={camera.name} segments={segments} />
        )}
      </div>
    </div>
  );
}
