'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Download, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { RecordingSegment, fetchRecordingSegments } from '@/services/recordingsService';
import { formatDuration } from '@/hooks/useCameraUptime';
import { detectionService } from '@/services/detectionService';
import { Detection } from '@/types/detection';

// No browser API reliably exposes a recording's actual frame rate for a
// plain <video> element, so frame-stepping uses a fixed assumption instead
// -- 25fps is a safe, common default for this kind of footage. It only
// affects stepping precision (how far one "frame" nudges playback), never
// correctness of what's shown.
const FRAME_SECONDS = 1 / 25;

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

// How far on either side of a requested play point to ask the recording
// service for -- empirically, its playback URLs 409 ("Overlapping
// recordings require a narrower range") for any window much wider than
// ~15 minutes, even though its own /list response for a wide query still
// reports one segment spanning the whole thing with a `duration` that
// looks fine. So a segment's own `duration` can't be trusted for playback
// once it was fetched with a wide range (the day-level fetch that feeds
// this component's `segments`/`span` props) -- only a narrow, freshly
// re-fetched window (well under that threshold) reliably has a playable
// url. This mirrors exactly what "Mark clip start/end" already does for
// exporting a clip; playback now does the same narrow re-fetch, just
// automatically around wherever the officer presses play.
const PLAYBACK_WINDOW_SECONDS = 5 * 60;

// A drag on the timeline shorter than this (in pixels) is treated as a plain
// click-to-seek rather than a zoom-select -- without a threshold, a hand
// that isn't perfectly still between mousedown/mouseup would zoom into a
// useless few-millisecond sliver on every ordinary click.
const ZOOM_DRAG_THRESHOLD_PX = 5;
// A drag-selected range narrower than this is discarded rather than pushed
// as a zoom level -- avoids a barely-there drag producing a zoom window so
// small it's not actually useful for finer scrubbing.
const MIN_ZOOM_SECONDS = 2;

interface RecordingPlayerProps {
  cameraId: number;
  cameraName: string;
  /** Segments to scrub through -- callers scope this to whatever range
   * makes sense for them (e.g. the Archive page passes just one calendar
   * day's segments so the scrubber's span matches the day it's showing),
   * freshly fetched so each segment's `url` token is still valid. */
  segments: RecordingSegment[];
  /** A specific moment to jump straight to (e.g. "10 seconds before this
   * plate was detected", from an alert's deep link) instead of starting
   * playback at the beginning of the day. Applied once, the first time it
   * falls within `segments`' span; ignored (falls back to the normal
   * start-at-0 behavior) if it's outside that span -- the wrong day's
   * segments may still be loading, or genuinely has no coverage there. */
  initialPlayFromIso?: string | null;
  /** Fired once initialPlayFromIso has actually been applied, so the
   * caller can clear it -- otherwise every later day the officer picks
   * manually would keep getting silently overridden by the original
   * deep-linked moment. */
  onInitialSeekApplied?: () => void;
}

/** The scrub/play/speed/export controls for a set of recorded segments --
 * deliberately has no opinion on *which* segments (a whole camera's history,
 * one calendar day, ...) or how it's framed (modal, page section); that's
 * entirely the caller's job. The one exception is exporting a marked clip:
 * an arbitrary [start, end) an officer marks rarely lines up with an
 * existing segment's own boundaries, so that one action mints its own
 * tightly-scoped segment via a fresh backend call instead of reusing
 * whatever was handed in. */
export function RecordingPlayer({
  cameraId,
  cameraName,
  segments,
  initialPlayFromIso,
  onInitialSeekApplied,
}: RecordingPlayerProps) {
  // Scrubber position, in seconds from the earliest segment in the current
  // set -- updates continuously as the officer drags, independent of what's
  // actually loaded in the player until they explicitly commit to it.
  const [previewSeconds, setPreviewSeconds] = useState(0);
  const [playFromSeconds, setPlayFromSeconds] = useState<number | null>(null);
  const [clipStartSeconds, setClipStartSeconds] = useState<number | null>(null);
  const [clipEndSeconds, setClipEndSeconds] = useState<number | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [activeClip, setActiveClip] = useState<{ url: string; offsetIntoSegment: number; autoPlay: boolean } | null>(null);
  const [activeClipLoading, setActiveClipLoading] = useState(false);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [markers, setMarkers] = useState<Detection[]>([]);
  // Stack of drag-zoomed [startSeconds, endSeconds] windows, most-recent
  // (most-zoomed-in) last -- empty means "showing the whole span." Chaining
  // (dragging again inside an already-zoomed view) pushes a further-nested
  // window, same as D3's brush+zoom and DevTools' flame-graph breadcrumbs;
  // popping one level (double-click, breadcrumb click, Escape) is just
  // truncating this array back to an earlier length.
  const [zoomStack, setZoomStack] = useState<[number, number][]>([]);
  // In-progress drag-select rectangle, in ratios (0-1) of the track's
  // current width -- null when no drag is active. A plain click leaves
  // start === end (zero width), which both naturally renders nothing and
  // is how pointerup below tells "click" apart from "drag."
  const [selection, setSelection] = useState<{ startRatio: number; endRatio: number } | null>(null);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const draggingHandleRef = useRef(false);
  const dragStartXRef = useRef(0);
  // Set right before an onEnded-triggered window advance so the fetch
  // effect below can tag the resulting clip as a seamless continuation
  // (autoplay, since the officer already had playback going) rather than a
  // fresh "Play from here"/marker click, which should never start audio
  // the officer didn't ask for.
  const autoAdvanceRef = useRef(false);

  const span = useMemo(() => (segments.length > 0 ? computeSpan(segments) : null), [segments]);
  // Tracks the last initialPlayFromIso value actually applied, so clearing
  // that prop back to null right after (the caller's own "consumed" signal
  // -- see onInitialSeekApplied) doesn't itself look like a fresh reset
  // request and snap the scrubber straight back to 0 the instant the seek
  // it just did takes effect.
  const appliedSeekRef = useRef<string | null>(null);

  // Segments changing (a different day picked) resets the scrubber to the
  // start of the new set rather than carrying over a position that belongs
  // to the previous one. Declared before the seek effect below so that
  // when both a new day AND a new deep-linked moment arrive in the same
  // render, this reset runs first and the seek (not 0) is what's left
  // standing once both effects have run.
  useEffect(() => {
    setPreviewSeconds(0);
    setPlayFromSeconds(segments.length > 0 ? 0 : null);
    setClipStartSeconds(null);
    setClipEndSeconds(null);
    setPlaybackError(null);
    setZoomStack([]);
  }, [segments]);

  // A genuinely new deep-linked moment (a fresh initialPlayFromIso value,
  // not just the same one re-handed-in, and not it being cleared back to
  // null) jumps straight there instead of wherever the effect above left
  // the scrubber -- independent of whether `segments` itself changed, so
  // "the same camera's next alert, same day" (segments unchanged) still
  // re-seeks correctly instead of silently doing nothing.
  useEffect(() => {
    if (!initialPlayFromIso || initialPlayFromIso === appliedSeekRef.current || !span) return;
    appliedSeekRef.current = initialPlayFromIso;
    const offset = (new Date(initialPlayFromIso).getTime() - span.earliestStartMs) / 1000;
    if (offset < 0 || offset > span.totalSeconds) return;
    setPreviewSeconds(offset);
    setPlayFromSeconds(offset);
    setClipStartSeconds(null);
    setClipEndSeconds(null);
    setPlaybackError(null);
    setZoomStack([]);
    onInitialSeekApplied?.();
  }, [initialPlayFromIso, span, onInitialSeekApplied]);

  const previewIso = useMemo(
    () => (span ? new Date(span.earliestStartMs + previewSeconds * 1000).toISOString() : null),
    [span, previewSeconds]
  );

  // Confirmed plate sightings for this camera across the currently-shown
  // span, rendered as clickable marks on the timeline -- lets an officer see
  // at a glance where a plate was already found instead of scrubbing blind.
  // Swallows failures to an empty list: a marker layer that fails to load
  // shouldn't block playback itself.
  useEffect(() => {
    if (!span) {
      setMarkers([]);
      return;
    }
    let cancelled = false;
    detectionService
      .search({
        camera_id: cameraId,
        from: new Date(span.earliestStartMs).toISOString(),
        to: new Date(span.latestEndMs).toISOString(),
      })
      .then((results) => {
        if (!cancelled) setMarkers(results);
      })
      .catch(() => {
        if (!cancelled) setMarkers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [cameraId, span]);

  // Always re-fetches a narrow window right around the play point instead
  // of reusing whatever URL came back with `segments` (see
  // PLAYBACK_WINDOW_SECONDS) -- a segment fetched with a wide range (e.g.
  // this component's day-level `segments` prop) reports a `duration`
  // spanning the whole request, but its `url` 409s the moment it's
  // actually played if that span crosses the recording service's own
  // overlapping-file boundaries. A fresh, narrow fetch is the only
  // reliable way to get something playable, mirroring the clip-export
  // effect below exactly.
  useEffect(() => {
    if (playFromSeconds === null || !span) {
      setActiveClip(null);
      return;
    }
    let cancelled = false;
    const shouldAutoPlay = autoAdvanceRef.current;
    autoAdvanceRef.current = false;
    setActiveClipLoading(true);
    setPlaybackError(null);
    const playPointMs = span.earliestStartMs + playFromSeconds * 1000;
    const windowStart = new Date(playPointMs - (PLAYBACK_WINDOW_SECONDS / 2) * 1000).toISOString();
    const windowEnd = new Date(playPointMs + (PLAYBACK_WINDOW_SECONDS / 2) * 1000).toISOString();
    fetchRecordingSegments(cameraId, { start: windowStart, end: windowEnd })
      .then((result) => {
        if (cancelled) return;
        // Must be the segment that actually covers playPointMs, not just
        // whichever one the service listed first -- a narrow window
        // straddling a gap can come back with a segment that starts after
        // (or ends before) the requested moment, and blindly playing that
        // one silently shows the wrong footage instead of "no footage here."
        const segment = result.segments.find((s) => {
          const segStartMs = new Date(s.start).getTime();
          const segEndMs = segStartMs + s.duration * 1000;
          return playPointMs >= segStartMs && playPointMs < segEndMs;
        });
        if (!segment) {
          setActiveClip(null);
          return;
        }
        const segStartMs = new Date(segment.start).getTime();
        setActiveClip({
          url: segment.url,
          offsetIntoSegment: Math.max(0, (playPointMs - segStartMs) / 1000),
          autoPlay: shouldAutoPlay,
        });
      })
      .catch((err) => {
        if (!cancelled) {
          setActiveClip(null);
          setPlaybackError(err instanceof Error ? err.message : 'Failed to load footage for this moment');
        }
      })
      .finally(() => {
        if (!cancelled) setActiveClipLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cameraId, playFromSeconds, span]);

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
    const requestedSeconds = clipEndSeconds - clipStartSeconds;
    fetchRecordingSegments(cameraId, { start: startIso, end: endIso })
      .then((result) => {
        if (cancelled) return;
        const segments = result.segments;
        const first = segments[0];
        if (!first) {
          setExportUrl(null);
          setExportError('No continuous footage available in that exact range.');
          return;
        }
        setExportUrl(first.url);
        // A gap in the marked range shows up one of two ways: the service
        // splits the request into more than one disjoint segment (a gap
        // somewhere in the middle), or hands back a single segment shorter
        // than what was actually requested (recording stops partway
        // through, most often at the end). Either way, only the first
        // segment is ever exported -- silently handing back a partial clip
        // with no indication of that would look like a normal, complete
        // export. `duration` can come back with float rounding a hair under
        // the exact request even when it's genuinely a full match, hence
        // the 1s slack.
        const coversWholeRange = segments.length === 1 && first.duration >= requestedSeconds - 1;
        if (!coversWholeRange) {
          setExportError(
            segments.length > 1
              ? `Recording has a gap in this range -- exported only the first continuous span (${formatDuration(first.duration)} of the marked ${formatDuration(requestedSeconds)}). Narrow the range to avoid the gap.`
              : `Recording doesn't fully cover the marked range -- exported only the first ${formatDuration(first.duration)} of ${formatDuration(requestedSeconds)}.`
          );
        }
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

  // Seeks the <video> element to activeClip's offset whenever activeClip
  // changes -- necessary in addition to the <video>'s own onLoadedMetadata
  // handler below, not instead of it. The recording service can return the
  // identical url/token for two different "Play from here" clicks that both
  // land inside the same already-fetched window/segment (a re-fetch is
  // still triggered, but resolves to the same file) -- React's `key`, keyed
  // off that url, then never remounts the element, so onLoadedMetadata
  // (which only fires on a fresh load) would silently never re-apply the
  // new offset, leaving playback stuck at wherever it happened to be. When
  // the element truly is fresh (key did change), its metadata isn't loaded
  // yet (readyState 0) and this intentionally does nothing, leaving the
  // seek to onLoadedMetadata once it fires.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeClip) return;
    if (video.readyState >= 1) {
      video.currentTime = activeClip.offsetIntoSegment;
    }
  }, [activeClip]);

  const setRate = (rate: number) => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  };

  const stepFrame = (direction: 1 | -1) => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = Math.max(0, video.currentTime + direction * FRAME_SECONDS);
  };

  const handlePlayerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === '.') {
      e.preventDefault();
      stepFrame(1);
    } else if (e.key === ',') {
      e.preventDefault();
      stepFrame(-1);
    }
  };

  // The active window's own playable duration matches exactly what was
  // requested (PLAYBACK_WINDOW_SECONDS, centered on playFromSeconds) -- the
  // recording service clips its returned segment to the requested range
  // rather than handing back its full underlying file. So reaching the end
  // of this <video>'s src means "ran off the edge of the fetched window,"
  // not "no more footage exists" -- advance to the next window and keep
  // going instead of just stopping, unless there's genuinely nothing left
  // in the day's span.
  const handleEnded = () => {
    if (playFromSeconds === null || !span) return;
    const nextSeconds = playFromSeconds + PLAYBACK_WINDOW_SECONDS / 2;
    if (nextSeconds >= span.totalSeconds) return;
    autoAdvanceRef.current = true;
    setPreviewSeconds(nextSeconds);
    setPlayFromSeconds(nextSeconds);
  };

  const jumpToMarker = (detection: Detection) => {
    if (!span) return;
    const offset = (new Date(detection.detected_at).getTime() - span.earliestStartMs) / 1000;
    if (offset < 0 || offset > span.totalSeconds) return;
    setZoomStack([]); // guarantee the target is visible even if a stale zoom window doesn't cover it
    setPreviewSeconds(offset);
    setPlayFromSeconds(offset);
  };

  // The currently-visible [start, end] window on the track, in seconds from
  // the span's own start -- the whole span when zoomStack is empty, or the
  // most-recently-pushed (most-zoomed-in) entry otherwise. Every rendering
  // computation below (marker/handle position, hover time, click-to-seek)
  // goes through this rather than `span.totalSeconds` directly, so zooming
  // never touches the underlying seconds-based state, only what's visible.
  const visibleRange = useMemo<[number, number]>(() => {
    if (!span) return [0, 0];
    return zoomStack.length > 0 ? zoomStack[zoomStack.length - 1] : [0, span.totalSeconds];
  }, [zoomStack, span]);

  const toPercent = (seconds: number) => {
    const [start, end] = visibleRange;
    return end === start ? 0 : ((seconds - start) / (end - start)) * 100;
  };

  const secondsFromRatio = (ratio: number) => visibleRange[0] + ratio * (visibleRange[1] - visibleRange[0]);

  const ratioFromClientX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  // Whole-track pointer handling drives three distinct gestures off one
  // surface, split by *what* was pressed and *how far* the pointer moved --
  // mirroring how D3's brush+zoom and Highcharts' navigator separate
  // "drag the handle to scrub" from "drag empty track to select a zoom
  // range," since a plain <input type="range"> can't distinguish these (see
  // the recording/playback roadmap memory for the research this is based
  // on):
  //  - pointerdown on the playhead handle itself -> scrub (updates
  //    previewSeconds live on every move, exactly like the old native range
  //    input's onChange did).
  //  - pointerdown elsewhere, released without crossing the drag threshold
  //    -> a plain click-to-seek.
  //  - pointerdown elsewhere, dragged past the threshold -> zoom-select;
  //    releasing pushes the dragged range onto zoomStack.
  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    trackRef.current?.setPointerCapture?.(e.pointerId);
    dragStartXRef.current = e.clientX;
    if (e.target === handleRef.current) {
      draggingHandleRef.current = true;
      setSelection(null);
    } else {
      draggingHandleRef.current = false;
      const ratio = ratioFromClientX(e.clientX);
      setSelection({ startRatio: ratio, endRatio: ratio });
    }
  };

  const handleTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const ratio = ratioFromClientX(e.clientX);
    setHoverRatio(ratio);
    if (draggingHandleRef.current) {
      setPreviewSeconds(secondsFromRatio(ratio));
    } else if (selection) {
      setSelection((prev) => (prev ? { ...prev, endRatio: ratio } : prev));
    }
  };

  const handleTrackPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    trackRef.current?.releasePointerCapture?.(e.pointerId);
    if (draggingHandleRef.current) {
      draggingHandleRef.current = false;
      setSelection(null);
      return;
    }
    if (selection) {
      const deltaPx = Math.abs(e.clientX - dragStartXRef.current);
      if (deltaPx >= ZOOM_DRAG_THRESHOLD_PX) {
        const startSec = secondsFromRatio(Math.min(selection.startRatio, selection.endRatio));
        const endSec = secondsFromRatio(Math.max(selection.startRatio, selection.endRatio));
        if (endSec - startSec >= MIN_ZOOM_SECONDS) {
          setZoomStack((prev) => [...prev, [startSec, endSec]]);
          setPreviewSeconds(startSec);
        }
      } else {
        setPreviewSeconds(secondsFromRatio(selection.startRatio));
      }
    }
    setSelection(null);
  };

  const handleTrackPointerLeave = () => {
    if (!selection && !draggingHandleRef.current) setHoverRatio(null);
  };

  const handleTrackDoubleClick = () => {
    setZoomStack((prev) => prev.slice(0, -1));
  };

  // Keyboard equivalent of everything the drag gestures above do -- a plain
  // <input type="range"> came with arrow-key seeking for free; replacing it
  // with a custom track means that has to be built back in explicitly, or
  // keyboard-only use would be a regression.
  const handleTrackKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setPreviewSeconds((s) => Math.max(visibleRange[0], s - step));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setPreviewSeconds((s) => Math.min(visibleRange[1], s + step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setPreviewSeconds(visibleRange[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      setPreviewSeconds(visibleRange[1]);
    } else if (e.key === 'Escape' && zoomStack.length > 0) {
      e.preventDefault();
      setZoomStack((prev) => prev.slice(0, -1));
    }
  };

  if (!span) {
    return <p className="text-xs text-slate-500">No recorded footage for this day.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {playFromSeconds !== null && (
        activeClipLoading ? (
          <div className="bg-black rounded overflow-hidden aspect-video flex items-center justify-center">
            <Loader2 size={20} className="text-slate-500 animate-spin" />
          </div>
        ) : activeClip ? (
          <div
            className="bg-black rounded overflow-hidden aspect-video"
            tabIndex={0}
            onKeyDown={handlePlayerKeyDown}
          >
            <video
              key={activeClip.url}
              ref={videoRef}
              src={activeClip.url}
              controls
              autoPlay={activeClip.autoPlay}
              className="w-full h-full"
              onLoadedMetadata={(e) => {
                e.currentTarget.currentTime = activeClip.offsetIntoSegment;
              }}
              onEnded={handleEnded}
              onError={() => setPlaybackError('Playback failed for this moment — try "Play from here" again, or pick a slightly different point.')}
            />
          </div>
        ) : (
          <p className="text-xs text-slate-500">No recorded footage at this exact time.</p>
        )
      )}
      {playbackError && <p className="text-xs text-signal-red">{playbackError}</p>}

      {playFromSeconds !== null && activeClip && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold tracking-wider text-slate-500 uppercase mr-1">Frame</span>
          <button
            type="button"
            onClick={() => stepFrame(-1)}
            aria-label="Step back one frame"
            className="p-1 rounded border border-line text-slate-300 hover:text-white hover:bg-panel-raised"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            onClick={() => stepFrame(1)}
            aria-label="Step forward one frame"
            className="p-1 rounded border border-line text-slate-300 hover:text-white hover:bg-panel-raised"
          >
            <ChevronRight size={14} />
          </button>
          <span className="text-[10px] text-slate-600">(or , / . keys while the player is focused)</span>
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
        {zoomStack.length > 0 && (
          <div className="flex items-center gap-1 text-[10px] text-slate-400 mb-1 flex-wrap">
            <button type="button" onClick={() => setZoomStack([])} className="hover:text-white hover:underline">
              Full range
            </button>
            {zoomStack.map((range, i) => (
              <React.Fragment key={i}>
                <span className="text-slate-600">›</span>
                <button
                  type="button"
                  onClick={() => setZoomStack((prev) => prev.slice(0, i + 1))}
                  className="hover:text-white hover:underline font-mono"
                >
                  {formatClockTime(new Date(span.earliestStartMs + range[0] * 1000).toISOString())}–
                  {formatClockTime(new Date(span.earliestStartMs + range[1] * 1000).toISOString())}
                </button>
              </React.Fragment>
            ))}
            <button
              type="button"
              onClick={() => setZoomStack((prev) => prev.slice(0, -1))}
              aria-label="Zoom out one level"
              className="ml-1 px-1.5 py-0.5 rounded border border-line text-slate-300 hover:text-white hover:bg-panel-raised"
            >
              Zoom out
            </button>
          </div>
        )}
        <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
          <span>{formatClockTime(new Date(span.earliestStartMs + visibleRange[0] * 1000).toISOString())}</span>
          <span className="font-mono text-slate-200">{previewIso && formatClockTime(previewIso)}</span>
          <span>{formatClockTime(new Date(span.earliestStartMs + visibleRange[1] * 1000).toISOString())}</span>
        </div>
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Scrub recorded footage timeline"
          aria-valuemin={visibleRange[0]}
          aria-valuemax={visibleRange[1]}
          aria-valuenow={previewSeconds}
          aria-valuetext={previewIso ? formatClockTime(previewIso) : undefined}
          onPointerDown={handleTrackPointerDown}
          onPointerMove={handleTrackPointerMove}
          onPointerUp={handleTrackPointerUp}
          onPointerLeave={handleTrackPointerLeave}
          onDoubleClick={handleTrackDoubleClick}
          onKeyDown={handleTrackKeyDown}
          className="relative h-6 rounded bg-panel-raised cursor-pointer select-none touch-none focus:outline-none focus:ring-1 focus:ring-command"
        >
          <div className="absolute inset-y-0 left-0 right-0 top-1/2 -translate-y-1/2 h-1 mx-1 rounded bg-line pointer-events-none" />

          {markers.map((detection) => {
            const offset = (new Date(detection.detected_at).getTime() - span.earliestStartMs) / 1000;
            if (offset < visibleRange[0] || offset > visibleRange[1]) return null;
            return (
              <button
                key={detection.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  jumpToMarker(detection);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                title={`${detection.plate_number} — ${formatClockTime(detection.detected_at)}`}
                aria-label={`Jump to detection: ${detection.plate_number} at ${formatClockTime(detection.detected_at)}`}
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-1 h-3.5 bg-signal-amber rounded-sm hover:h-5 hover:bg-command"
                style={{ left: `${toPercent(offset)}%` }}
              />
            );
          })}

          {selection && Math.abs(selection.endRatio - selection.startRatio) > 0.001 && (
            <div
              className="absolute inset-y-0 bg-command/25 border-x border-command pointer-events-none"
              style={{
                left: `${Math.min(selection.startRatio, selection.endRatio) * 100}%`,
                width: `${Math.abs(selection.endRatio - selection.startRatio) * 100}%`,
              }}
            />
          )}

          {previewSeconds >= visibleRange[0] && previewSeconds <= visibleRange[1] && (
            <div
              ref={handleRef}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-command border-2 border-white/80 cursor-ew-resize shadow"
              style={{ left: `${toPercent(previewSeconds)}%` }}
            />
          )}

          {hoverRatio !== null && (
            <div
              data-testid="timeline-hover-tooltip"
              className="absolute -top-7 px-1.5 py-0.5 text-[10px] font-mono text-slate-200 bg-panel-raised border border-line rounded whitespace-nowrap pointer-events-none z-10"
              style={{
                left: `${hoverRatio * 100}%`,
                transform: hoverRatio < 0.08 ? 'translateX(0)' : hoverRatio > 0.92 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {formatClockTime(new Date(span.earliestStartMs + secondsFromRatio(hoverRatio) * 1000).toISOString())}
            </div>
          )}
        </div>
        <p className="text-[10px] text-slate-600 mt-1">
          Drag a range to zoom in for finer scrubbing, double-click to zoom back out.
        </p>
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
