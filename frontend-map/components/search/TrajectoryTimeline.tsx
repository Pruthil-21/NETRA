'use client';

import React, { useEffect, useState } from 'react';
import { Pause, Play, SkipBack, TriangleAlert } from 'lucide-react';
import { ResolvedSighting } from '@/lib/buildSightingRoute';
import { PredictedNextCamera } from '@/types/detection';

// Fixed pace between stops while auto-playing -- a scrubber, not a physically
// accurate speed simulation, so a flat interval is both simpler and reads
// more predictably than scaling by the real (often very uneven) gaps between
// camera hits.
const STEP_MS = 1200;

interface TrajectoryTimelineProps {
  /** Same list CameraMap draws the route from (see buildSightingRoute.ts) --
   * sharing it is what keeps "stop 3 of 7" here pointed at the same point
   * CameraMap renders as the 3rd stop. */
  resolved: ResolvedSighting[];
  currentIndex: number;
  onIndexChange: (index: number) => void;
  /** Where the network has historically gone next from the LAST stop's
   * camera (see detectionService.predictNextCamera) -- only meaningful, and
   * only shown, while viewing that last stop; scrubbing back to an earlier
   * stop hides it, since "predicted next" only makes sense from the plate's
   * actual current position. */
  predictedNext?: PredictedNextCamera[];
}

/** Chronological playback control for a plate's route: scrub to any stop
 * directly, or auto-play forward through them one at a time. Renders nothing
 * for a single-point or empty route -- there's nothing to scrub through. */
export const TrajectoryTimeline: React.FC<TrajectoryTimelineProps> = ({
  resolved,
  currentIndex,
  onIndexChange,
  predictedNext,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (!isPlaying) return;
    if (currentIndex >= resolved.length - 1) {
      setIsPlaying(false);
      return;
    }
    const timer = setTimeout(() => onIndexChange(currentIndex + 1), STEP_MS);
    return () => clearTimeout(timer);
  }, [isPlaying, currentIndex, resolved.length, onIndexChange]);

  if (resolved.length < 2) return null;

  const active = resolved[currentIndex];

  const handleRestart = () => {
    setIsPlaying(false);
    onIndexChange(0);
  };

  const handlePlayToggle = () => {
    if (!isPlaying && currentIndex >= resolved.length - 1) {
      onIndexChange(0);
    }
    setIsPlaying((prev) => !prev);
  };

  const handleScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    setIsPlaying(false);
    onIndexChange(Number(e.target.value));
  };

  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-[1000] w-[min(92%,640px)] px-4 py-2.5 rounded-lg bg-panel/95 border border-line shadow-lg backdrop-blur">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleRestart}
          aria-label="Restart trajectory from the first sighting"
          className="shrink-0 text-slate-400 hover:text-white transition"
        >
          <SkipBack size={16} />
        </button>
        <button
          type="button"
          onClick={handlePlayToggle}
          aria-label={isPlaying ? 'Pause trajectory playback' : 'Play trajectory playback'}
          className="shrink-0 w-7 h-7 rounded-full bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center transition"
        >
          {isPlaying ? <Pause size={13} /> : <Play size={13} className="ml-0.5" />}
        </button>
        <input
          type="range"
          min={0}
          max={resolved.length - 1}
          value={currentIndex}
          onChange={handleScrub}
          aria-label="Trajectory timeline scrubber"
          className="flex-1 accent-blue-500"
        />
        <span className="shrink-0 text-[10px] font-mono text-slate-500">
          {currentIndex + 1}/{resolved.length}
        </span>
      </div>
      {active && (
        <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px]">
          <span className="font-semibold text-slate-200 truncate">
            {active.camera.name || `Camera #${active.camera.id}`}
          </span>
          <span className="shrink-0 flex items-center gap-2 text-slate-400 font-mono">
            {active.speedKmh != null && (
              <span className="text-blue-300">~{active.speedKmh} km/h from previous stop</span>
            )}
            {new Date(active.sighting.detected_at).toLocaleString()}
          </span>
        </div>
      )}
      {active?.anomaly && (
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-rose-400">
          <TriangleAlert size={11} className="shrink-0" />
          <span>
            {active.anomaly === 'improbable_speed'
              ? 'Improbable speed for this leg — possible OCR mismatch, worth a second look'
              : 'Unusually long gap before this sighting — worth a second look'}
          </span>
        </div>
      )}
      {currentIndex === resolved.length - 1 && predictedNext != null && predictedNext.length > 0 && (
        <div className="mt-1.5 pt-1.5 border-t border-line/60 text-[10px] text-slate-400">
          <span className="text-slate-500 uppercase tracking-wide">Predicted next: </span>
          {predictedNext.map((candidate, i) => (
            <span key={candidate.camera_id}>
              {i > 0 && ', '}
              <span className="text-emerald-300">
                {candidate.camera_name || `Camera #${candidate.camera_id}`}
              </span>{' '}
              ({Math.round(candidate.confidence * 100)}%)
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export default TrajectoryTimeline;
