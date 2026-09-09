'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Download, Loader2 } from 'lucide-react';
import { RecordingSegment, fetchRecordingSegments } from '@/services/recordingsService';
import { formatDuration } from '@/hooks/useCameraUptime';

const PLAYBACK_RATES = [0.25, 0.5, 1, 2, 4];

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

/** Finds which segment (if any) covers a given offset, in seconds from the
 * span's start -- each segment's own `url` already carries a token scoped
 * to exactly that segment's [start, start+duration) window, so playing an
 * arbitrary point within it means picking the right segment and seeking
 * the <video> element, never building a new URL. Returns null for a point
 * that falls in a gap (no coverage at that moment). */
function findCoveringSegment(
  segments: RecordingSegment[],
  offsetSeconds: number,
  earliestStartMs: number
): { url: string; offsetIntoSegment: number } | null {
  for (const segment of segments) {
    const segStart = (new Date(segment.start).getTime() - earliestStartMs) / 1000;
    if (offsetSeconds >= segStart && offsetSeconds < segStart + segment.duration) {
      return { url: segment.url, offsetIntoSegment: offsetSeconds - segStart };
    }
  }
  return null;
}

interface RecordingPlayerProps {
  cameraId: number;
  cameraName: string;
  /** Segments to scrub through -- callers scope this to whatever range
   * makes sense for them (e.g. the Archive page passes just one calendar
   * day's segments so the scrubber's span matches the day it's showing),
   * freshly fetched so each segment's `url` token is still valid. */
  segments: RecordingSegment[];
}

/** The scrub/play/speed/export controls for a set of recorded segments --
 * deliberately has no opinion on *which* segments (a whole camera's history,
 * one calendar day, ...) or how it's framed (modal, page section); that's
 * entirely the caller's job. The one exception is exporting a marked clip:
 * an arbitrary [start, end) an officer marks rarely lines up with an
 * existing segment's own boundaries, so that one action mints its own
 * tightly-scoped segment via a fresh backend call instead of reusing
 * whatever was handed in. */
export function RecordingPlayer({ cameraId, cameraName, segments }: RecordingPlayerProps) {
  // Scrubber position, in seconds from the earliest segment in the current
  // set -- updates continuously as the officer drags, independent of what's
  // actually loaded in the player until they explicitly commit to it.
  const [previewSeconds, setPreviewSeconds] = useState(0);
  const [playFromSeconds, setPlayFromSeconds] = useState<number | null>(null);
  const [clipStartSeconds, setClipStartSeconds] = useState<number | null>(null);
  const [clipEndSeconds, setClipEndSeconds] = useState<number | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
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
    setPlaybackError(null);
  }, [segments]);

  const previewIso = useMemo(
    () => (span ? new Date(span.earliestStartMs + previewSeconds * 1000).toISOString() : null),
    [span, previewSeconds]
  );

  const activeClip = useMemo(() => {
    if (playFromSeconds === null || !span) return null;
    return findCoveringSegment(segments, playFromSeconds, span.earliestStartMs);
  }, [playFromSeconds, span, segments]);

  useEffect(() => {
    setPlaybackError(null);
  }, [activeClip?.url]);

  // Marking both ends of a clip mints a fresh, tightly-scoped segment for
  // exactly that range -- an arbitrary officer-picked range essentially
  // never matches an existing segment's own boundaries, and only the
  // recording service can issue a valid token for it.
  useEffect(() => {
    if (clipStartSeconds === null || clipEndSeconds === null || !span || clipEndSeconds <= clipStartSeconds) {
      setExportUrl(null);
      setExportError(null);
      setExportLoading(false);
      return;
    }
    let cancelled = false;
    setExportLoading(true);
    setExportError(null);
    setExportUrl(null);
    const startIso = new Date(span.earliestStartMs + clipStartSeconds * 1000).toISOString();
    const endIso = new Date(span.earliestStartMs + clipEndSeconds * 1000).toISOString();
    fetchRecordingSegments(cameraId, { start: startIso, end: endIso })
      .then((result) => {
        if (cancelled) return;
        const url = result.segments[0]?.url ?? null;
        setExportUrl(url);
        if (!url) setExportError('No continuous footage available in that exact range.');
      })
      .catch((err) => {
        if (!cancelled) setExportError(err instanceof Error ? err.message : 'Failed to prepare clip');
      })
      .finally(() => {
        if (!cancelled) setExportLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cameraId, clipStartSeconds, clipEndSeconds, span]);

  const setRate = (rate: number) => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  };

  if (!span) {
    return <p className="text-xs text-slate-500">No recorded footage for this day.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {playFromSeconds !== null && (
        activeClip ? (
          <div className="bg-black rounded overflow-hidden aspect-video">
            <video
              key={activeClip.url}
              ref={videoRef}
              src={activeClip.url}
              controls
              className="w-full h-full"
              onLoadedMetadata={(e) => {
                e.currentTarget.currentTime = activeClip.offsetIntoSegment;
              }}
              onError={() => setPlaybackError('This clip link may have expired — reselect the day, or try again, to refresh it.')}
            />
          </div>
        ) : (
          <p className="text-xs text-slate-500">No recorded footage at this exact time.</p>
        )
      )}
      {playbackError && <p className="text-xs text-signal-red">{playbackError}</p>}

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
          {exportError
            ? exportError
            : clipStartSeconds !== null && clipEndSeconds !== null && clipEndSeconds > clipStartSeconds
              ? `Clip range: ${formatDuration(clipEndSeconds - clipStartSeconds)}`
              : 'Mark a clip start and end to export a range.'}
        </p>
        {exportLoading && (
          <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-slate-400">
            <Loader2 size={12} className="animate-spin" />
            Preparing clip…
          </span>
        )}
        {!exportLoading && exportUrl && (
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
