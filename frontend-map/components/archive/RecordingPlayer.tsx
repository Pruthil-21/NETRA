'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Download } from 'lucide-react';
import { buildPlaybackClipUrl } from '@/config/streams';
import { RecordingSegment } from '@/services/recordingsService';
import { formatDuration } from '@/hooks/useCameraUptime';

const PLAYBACK_RATES = [0.25, 0.5, 1, 2, 4];
// How much footage to request at once for continuous playback -- long enough
// an officer isn't constantly reloading, short enough MediaMTX doesn't have
// to concatenate an unreasonable number of segments for one request.
const PLAY_WINDOW_SECONDS = 600;

function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

interface Span {
  earliestStartMs: number;
  latestEndMs: number;
  totalSeconds: number;
}

function computeSpan(segments: RecordingSegment[]): Span {
  const starts = segments.map((s) => new Date(s.start).getTime());
  const ends = segments.map((s) => new Date(s.start).getTime() + s.duration * 1000);
  const earliestStartMs = Math.min(...starts);
  const latestEndMs = Math.max(...ends);
  return { earliestStartMs, latestEndMs, totalSeconds: (latestEndMs - earliestStartMs) / 1000 };
}

interface RecordingPlayerProps {
  pathId: string | number;
  cameraName: string;
  /** Segments to scrub through -- callers scope this to whatever range
   * makes sense for them (e.g. the Archive page passes just one calendar
   * day's segments so the scrubber's span matches the day it's showing). */
  segments: RecordingSegment[];
}

/** The scrub/play/speed/export controls for a set of recorded segments --
 * deliberately has no opinion on *which* segments (a whole camera's history,
 * one calendar day, ...) or how it's framed (modal, page section); that's
 * entirely the caller's job. */
export function RecordingPlayer({ pathId, cameraName, segments }: RecordingPlayerProps) {
  // Scrubber position, in seconds from the earliest segment in the current
  // set -- updates continuously as the officer drags, independent of what's
  // actually loaded in the player until they explicitly commit to it.
  const [previewSeconds, setPreviewSeconds] = useState(0);
  const [playFromSeconds, setPlayFromSeconds] = useState<number | null>(null);
  const [clipStartSeconds, setClipStartSeconds] = useState<number | null>(null);
  const [clipEndSeconds, setClipEndSeconds] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const span = useMemo(() => (segments.length > 0 ? computeSpan(segments) : null), [segments]);

  // Segments changing (a different day picked) resets the scrubber to the
  // start of the new set rather than carrying over a position that belongs
  // to the previous one.
  useEffect(() => {
    setPreviewSeconds(0);
    setPlayFromSeconds(segments.length > 0 ? 0 : null);
    setClipStartSeconds(null);
    setClipEndSeconds(null);
  }, [segments]);

  const previewIso = useMemo(
    () => (span ? new Date(span.earliestStartMs + previewSeconds * 1000).toISOString() : null),
    [span, previewSeconds]
  );

  const clipUrl = useMemo(() => {
    if (playFromSeconds === null || !span) return null;
    const remaining = span.totalSeconds - playFromSeconds;
    const startIso = new Date(span.earliestStartMs + playFromSeconds * 1000).toISOString();
    return buildPlaybackClipUrl(pathId, startIso, Math.min(PLAY_WINDOW_SECONDS, Math.max(1, remaining)));
  }, [pathId, playFromSeconds, span]);

  const exportUrl = useMemo(() => {
    if (clipStartSeconds === null || clipEndSeconds === null || !span || clipEndSeconds <= clipStartSeconds) return null;
    const startIso = new Date(span.earliestStartMs + clipStartSeconds * 1000).toISOString();
    return buildPlaybackClipUrl(pathId, startIso, clipEndSeconds - clipStartSeconds);
  }, [pathId, clipStartSeconds, clipEndSeconds, span]);

  const setRate = (rate: number) => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  };

  if (!span) {
    return <p className="text-xs text-slate-500">No recorded footage for this day.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {clipUrl && (
        <div className="bg-black rounded overflow-hidden aspect-video">
          <video key={clipUrl} ref={videoRef} src={clipUrl} controls className="w-full h-full" />
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase mr-1">Speed</span>
        {PLAYBACK_RATES.map((rate) => (
          <button
            key={rate}
            type="button"
            onClick={() => setRate(rate)}
            aria-label={`Set playback speed to ${rate}x`}
            className="px-2 py-1 text-[11px] rounded border border-line text-slate-300 hover:text-white hover:bg-panel-raised"
          >
            {rate}x
          </button>
        ))}
      </div>

      <div>
        <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
          <span>{formatClockTime(new Date(span.earliestStartMs).toISOString())}</span>
          <span className="font-mono text-slate-200">{previewIso && formatClockTime(previewIso)}</span>
          <span>{formatClockTime(new Date(span.latestEndMs).toISOString())}</span>
        </div>
        <input
          type="range"
          aria-label="Scrub recorded footage timeline"
          min={0}
          max={span.totalSeconds}
          step={1}
          value={previewSeconds}
          onChange={(e) => setPreviewSeconds(Number(e.target.value))}
          className="w-full accent-command"
        />
        <div className="flex items-center gap-2 mt-2">
          <button
            type="button"
            onClick={() => setPlayFromSeconds(previewSeconds)}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded border border-line text-slate-200 hover:text-white hover:bg-panel-raised"
          >
            <Play size={12} />
            Play from here
          </button>
          <button
            type="button"
            onClick={() => setClipStartSeconds(previewSeconds)}
            className="px-2.5 py-1.5 text-xs rounded border border-line text-slate-300 hover:text-white hover:bg-panel-raised"
          >
            Mark clip start
          </button>
          <button
            type="button"
            onClick={() => setClipEndSeconds(previewSeconds)}
            className="px-2.5 py-1.5 text-xs rounded border border-line text-slate-300 hover:text-white hover:bg-panel-raised"
          >
            Mark clip end
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-line pt-3">
        <p className="text-[11px] text-slate-500">
          {clipStartSeconds !== null && clipEndSeconds !== null && clipEndSeconds > clipStartSeconds
            ? `Clip range: ${formatDuration(clipEndSeconds - clipStartSeconds)}`
            : 'Mark a clip start and end to export a range.'}
        </p>
        {exportUrl && (
          <a
            href={exportUrl}
            download={`${cameraName.replace(/\s+/g, '_')}_clip.mp4`}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-line text-slate-200 hover:text-white hover:bg-panel-raised"
          >
            <Download size={12} />
            Export Clip
          </a>
        )}
      </div>
    </div>
  );
}
