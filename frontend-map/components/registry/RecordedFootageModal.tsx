'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Play, Download } from 'lucide-react';
import { Camera } from '@/types/camera';
import { buildPlaybackClipUrl } from '@/config/streams';
import { fetchRecordingSegments, RecordingSegment } from '@/services/recordingsService';
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

export default function RecordedFootageModal({ camera, onClose }: { camera: Camera; onClose: () => void }) {
  const [segments, setSegments] = useState<RecordingSegment[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Scrubber position, in seconds from the earliest available recording --
  // updates continuously as the officer drags, independent of what's
  // actually loaded in the player until they explicitly commit to it.
  const [previewSeconds, setPreviewSeconds] = useState(0);
  const [playFromSeconds, setPlayFromSeconds] = useState<number | null>(null);
  const [clipStartSeconds, setClipStartSeconds] = useState<number | null>(null);
  const [clipEndSeconds, setClipEndSeconds] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const pathId = camera.stream_id || camera.id;

  useEffect(() => {
    let cancelled = false;
    fetchRecordingSegments(camera.id)
      .then((result) => {
        if (cancelled) return;
        setAvailable(result.available);
        setSegments(result.segments);
        if (result.segments.length > 0) {
          const span = computeSpan(result.segments);
          setPreviewSeconds(span.totalSeconds);
          setPlayFromSeconds(span.totalSeconds);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load recordings');
      });
    return () => {
      cancelled = true;
    };
  }, [camera.id]);

  const span = useMemo(() => (segments && segments.length > 0 ? computeSpan(segments) : null), [segments]);

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

  return (
    <div
      className="fixed inset-0 z-[2000] bg-black/70 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recorded-footage-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl bg-panel border border-line rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 id="recorded-footage-title" className="text-sm font-semibold text-white tracking-wide">
            Recorded Footage — {camera.name}
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

        <div className="p-5">
          {error && <p className="text-xs text-signal-red mb-3">{error}</p>}

          {!error && segments === null && <p className="text-xs text-slate-500">Loading recordings…</p>}

          {!error && segments !== null && (!available || segments.length === 0) && (
            <p className="text-xs text-slate-500">
              No recorded footage available for this camera yet. Recording starts once the camera has been viewed live.
            </p>
          )}

          {span && clipUrl && (
            <div className="flex flex-col gap-4">
              <div className="bg-black rounded overflow-hidden aspect-video">
                <video key={clipUrl} ref={videoRef} src={clipUrl} controls className="w-full h-full" />
              </div>

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
                    download={`${camera.name.replace(/\s+/g, '_')}_clip.mp4`}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-line text-slate-200 hover:text-white hover:bg-panel-raised"
                  >
                    <Download size={12} />
                    Export Clip
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
