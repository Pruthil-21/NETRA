import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RecordingPlayer } from '@/components/archive/RecordingPlayer';
import { fetchRecordingSegments } from '@/services/recordingsService';
import { detectionService } from '@/services/detectionService';

vi.mock('@/services/recordingsService', async () => {
  const actual = await vi.importActual<typeof import('@/services/recordingsService')>('@/services/recordingsService');
  return { ...actual, fetchRecordingSegments: vi.fn() };
});

vi.mock('@/services/detectionService', () => ({
  detectionService: { search: vi.fn() },
}));

const SEGMENTS = [
  { start: '2026-09-05T08:00:00.000Z', duration: 600, url: 'https://playback.example/get?token=day-segment' },
];

// The timeline's drag-to-zoom/hover-tooltip math is driven off the track's
// own rendered pixel width (see ratioFromClientX in RecordingPlayer.tsx) --
// jsdom never actually lays anything out, so every element's real
// getBoundingClientRect would report 0 width. Stub a fixed-width track so a
// pointer event at a given clientX maps to a predictable ratio/second.
const TRACK_WIDTH = 300;

// jsdom doesn't implement the PointerEvent constructor at all (confirmed:
// `'PointerEvent' in window` is false on jsdom 24), so testing-library's
// `fireEvent.pointerDown/Move/Up/Leave` end up dispatching an event with no
// `clientX`/`pointerId` -- React's synthetic event then reports both as
// undefined, not 0. Dispatching a real `MouseEvent` with the same `type`
// string instead works: React's event system dispatches by matching the
// native event's `type`, not its class, so a "pointerdown"-typed MouseEvent
// still reaches the component's onPointerDown handler with a real clientX.
//
// "leave" is a special case: native leave events don't bubble, so React
// actually derives its synthetic onPointerLeave from the bubbling
// "pointerout" event plus `relatedTarget` (only counting it as a leave once
// relatedTarget is outside the target) rather than listening for a raw
// "pointerleave" event at all -- so simulating a leave means dispatching
// "pointerout" with a relatedTarget outside the element, not "pointerleave".
function firePointerEvent(el: Element, type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointerleave', clientX: number, pointerId = 1) {
  const nativeType = type === 'pointerleave' ? 'pointerout' : type;
  const event = new MouseEvent(nativeType, {
    clientX,
    bubbles: true,
    cancelable: true,
    relatedTarget: type === 'pointerleave' ? document.body : null,
  } as MouseEventInit);
  Object.defineProperty(event, 'pointerId', { value: pointerId, configurable: true });
  fireEvent(el, event);
}

/** Simulates a plain click-to-seek at `seconds` (pointerdown+pointerup at
 * the same X -- no drag, so the component treats it as a seek rather than a
 * zoom-select) within a `totalSeconds`-wide visible range. */
function seekTo(track: Element, seconds: number, totalSeconds: number) {
  const clientX = (seconds / totalSeconds) * TRACK_WIDTH;
  firePointerEvent(track, 'pointerdown', clientX);
  firePointerEvent(track, 'pointerup', clientX);
}

describe('RecordingPlayer', () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: TRACK_WIDTH, width: TRACK_WIDTH, top: 0, bottom: 24, height: 24, x: 0, y: 0,
      toJSON: () => {},
    } as DOMRect);

    vi.mocked(fetchRecordingSegments).mockReset();
    // Default: playback now always re-fetches a fresh, narrow window right
    // around the play point (see PLAYBACK_WINDOW_SECONDS in the component)
    // instead of trusting a pre-fetched wide-range segment's own url -- the
    // recording service 409s a playback url once its span crosses an
    // overlapping-file boundary, even though /list still happily reports a
    // wide `duration` for it. Individual tests override this mock when they
    // need to assert something about that fetch itself.
    vi.mocked(fetchRecordingSegments).mockResolvedValue({ available: true, segments: SEGMENTS, service_reachable: true });
    vi.mocked(detectionService.search).mockReset();
    vi.mocked(detectionService.search).mockResolvedValue([]);
  });

  it('shows a quiet message when given no segments', () => {
    render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={[]} />);
    expect(screen.getByText('No recorded footage for this day.')).toBeInTheDocument();
  });

  it('loads the player at the start of the given segments', async () => {
    render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const slider = screen.getByLabelText('Scrub recorded footage timeline');
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    await waitFor(() => {
      const video = document.querySelector('video');
      expect(video).toHaveAttribute('src', SEGMENTS[0].url);
    });
  });

  it('lets an officer scrub, mark a clip range, and export it', async () => {
    vi.mocked(fetchRecordingSegments).mockResolvedValue({
      available: true,
      segments: [{ start: '2026-09-05T08:01:40.000Z', duration: 300, url: 'https://playback.example/get?token=clip' }],
      service_reachable: true,
    });

    render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const slider = screen.getByLabelText('Scrub recorded footage timeline');

    seekTo(slider, 100, 600);
    fireEvent.click(screen.getByText('Mark clip start'));
    seekTo(slider, 400, 600);
    fireEvent.click(screen.getByText('Mark clip end'));

    expect(await screen.findByText(/Clip range: 5m 0s/)).toBeInTheDocument();

    expect(fetchRecordingSegments).toHaveBeenCalledWith(
      7,
      { start: '2026-09-05T08:01:40.000Z', end: '2026-09-05T08:06:40.000Z' }
    );

    const exportLink = await screen.findByText('Export Clip');
    expect(exportLink.closest('a')).toHaveAttribute('href', 'https://playback.example/get?token=clip');
  });

  it('shows an error when no continuous footage covers the marked range', async () => {
    vi.mocked(fetchRecordingSegments).mockResolvedValue({ available: false, segments: [], service_reachable: true });

    render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const slider = screen.getByLabelText('Scrub recorded footage timeline');

    seekTo(slider, 100, 600);
    fireEvent.click(screen.getByText('Mark clip start'));
    seekTo(slider, 400, 600);
    fireEvent.click(screen.getByText('Mark clip end'));

    await waitFor(() => {
      expect(screen.getByText('No continuous footage available in that exact range.')).toBeInTheDocument();
    });
    expect(screen.queryByText('Export Clip')).not.toBeInTheDocument();
  });

  it('warns about a gap in the marked range instead of silently exporting only the first span', async () => {
    // Two disjoint segments covering only part of the marked [100s, 400s]
    // range -- a real recording gap somewhere in the middle.
    vi.mocked(fetchRecordingSegments).mockResolvedValue({
      available: true,
      segments: [
        { start: '2026-09-05T08:01:40.000Z', duration: 60, url: 'https://playback.example/get?token=first-span' },
        { start: '2026-09-05T08:04:00.000Z', duration: 60, url: 'https://playback.example/get?token=second-span' },
      ],
      service_reachable: true,
    });

    render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const slider = screen.getByLabelText('Scrub recorded footage timeline');

    seekTo(slider, 100, 600);
    fireEvent.click(screen.getByText('Mark clip start'));
    seekTo(slider, 400, 600);
    fireEvent.click(screen.getByText('Mark clip end'));

    expect(await screen.findByText(/Recording has a gap in this range/)).toBeInTheDocument();
    // Still exports the first continuous span rather than blocking entirely.
    const exportLink = await screen.findByText('Export Clip');
    expect(exportLink.closest('a')).toHaveAttribute('href', 'https://playback.example/get?token=first-span');
  });

  it('warns when the single covering segment stops short of the full marked range', async () => {
    // One segment, but recording ends partway through the marked 300s range.
    vi.mocked(fetchRecordingSegments).mockResolvedValue({
      available: true,
      segments: [{ start: '2026-09-05T08:01:40.000Z', duration: 120, url: 'https://playback.example/get?token=partial' }],
      service_reachable: true,
    });

    render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const slider = screen.getByLabelText('Scrub recorded footage timeline');

    seekTo(slider, 100, 600);
    fireEvent.click(screen.getByText('Mark clip start'));
    seekTo(slider, 400, 600);
    fireEvent.click(screen.getByText('Mark clip end'));

    expect(await screen.findByText(/doesn't fully cover the marked range/)).toBeInTheDocument();
    const exportLink = await screen.findByText('Export Clip');
    expect(exportLink.closest('a')).toHaveAttribute('href', 'https://playback.example/get?token=partial');
  });

  it('jumps straight to a deep-linked moment (e.g. 10s before a plate match) instead of the start', () => {
    const onInitialSeekApplied = vi.fn();
    render(
      <RecordingPlayer
        cameraId={7}
        cameraName="Ring Road Camera"
        segments={SEGMENTS}
        initialPlayFromIso="2026-09-05T08:02:00.000Z"
        onInitialSeekApplied={onInitialSeekApplied}
      />
    );
    // SEGMENTS[0] starts at 08:00:00; 08:02:00 is 120s in.
    expect(screen.getByLabelText('Scrub recorded footage timeline')).toHaveAttribute('aria-valuenow', '120');
    expect(onInitialSeekApplied).toHaveBeenCalledTimes(1);
  });

  it('falls back to the normal start-at-0 behavior when the deep-linked moment falls outside the given segments', () => {
    const onInitialSeekApplied = vi.fn();
    render(
      <RecordingPlayer
        cameraId={7}
        cameraName="Ring Road Camera"
        segments={SEGMENTS}
        initialPlayFromIso="2026-09-06T08:02:00.000Z"
        onInitialSeekApplied={onInitialSeekApplied}
      />
    );
    expect(screen.getByLabelText('Scrub recorded footage timeline')).toHaveAttribute('aria-valuenow', '0');
    expect(onInitialSeekApplied).not.toHaveBeenCalled();
  });

  it('seeks correctly when "Play from here" is clicked again for a different point inside the same clip', async () => {
    // Each narrow re-fetch gets its own distinct url (the recording service
    // mints a fresh token per requested window -- see the real /list~/get
    // behavior confirmed earlier against api.digdhrishti.me), so every
    // "Play from here" click swaps in a genuinely fresh <video> (via the
    // activeClipLoading spinner interposing, then a new key). The offset
    // into that fresh segment is always PLAYBACK_WINDOW_SECONDS/2 (150s)
    // since the service always returns a segment starting exactly at the
    // requested window's start. This proves a SECOND click at a different
    // point (still within the same day's `segments`, i.e. "the same clip")
    // correctly re-seeks on its own fresh element, not left over from the
    // first click's.
    vi.mocked(fetchRecordingSegments).mockImplementation(async (_cameraId, range) => ({
      available: true,
      segments: range
        ? [{
            start: range.start,
            duration: (new Date(range.end).getTime() - new Date(range.start).getTime()) / 1000,
            url: `https://playback.example/get?start=${range.start}`,
          }]
        : [],
      service_reachable: true,
    }));

    render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const firstVideo = await waitFor(() => {
      const el = document.querySelector('video');
      expect(el).not.toBeNull();
      return el as HTMLVideoElement;
    });
    fireEvent.loadedMetadata(firstVideo);
    expect(firstVideo.currentTime).toBe(150); // PLAYBACK_WINDOW_SECONDS / 2

    const slider = screen.getByLabelText('Scrub recorded footage timeline');
    seekTo(slider, 250, 600);
    fireEvent.click(screen.getByText('Play from here'));

    const secondVideo = await waitFor(() => {
      const el = document.querySelector('video');
      expect(el).not.toBeNull();
      expect(el).not.toBe(firstVideo); // a fresh element for the new window/url
      return el as HTMLVideoElement;
    });
    fireEvent.loadedMetadata(secondVideo);
    expect(secondVideo.currentTime).toBe(150);
  });

  it('plays the segment that actually contains the requested moment, not just whichever one is listed first', async () => {
    // The narrow re-fetch around a play point can come back with more than
    // one segment (e.g. a short leftover sliver from just before a gap,
    // followed by the segment that actually covers the requested moment).
    // Blindly taking segments[0] would silently play the wrong footage.
    vi.mocked(fetchRecordingSegments).mockImplementation(async (_cameraId, range) => {
      if (!range) return { available: true, segments: [], service_reachable: true };
      return {
        available: true,
        segments: [
          { start: '2026-09-05T07:58:00.000Z', duration: 60, url: 'https://playback.example/get?token=stale-sliver' },
          { start: '2026-09-05T08:04:00.000Z', duration: 600, url: 'https://playback.example/get?token=covers-request' },
        ],
        service_reachable: true,
      };
    });

    render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const slider = screen.getByLabelText('Scrub recorded footage timeline');
    seekTo(slider, 300, 600); // 08:05:00 -- inside the second segment (08:04:00-08:14:00), not the first
    fireEvent.click(screen.getByText('Play from here'));

    const video = await waitFor(() => {
      const el = document.querySelector('video');
      expect(el).toHaveAttribute('src', 'https://playback.example/get?token=covers-request');
      return el as HTMLVideoElement;
    });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(60); // 08:05:00 is 60s into the 08:04:00 segment
  });

  it('shows "no footage" instead of playing an unrelated segment when the requested moment falls in a gap', async () => {
    // Every segment the narrow re-fetch returns lies entirely outside the
    // requested play point -- a real gap, not just a listing-order issue.
    vi.mocked(fetchRecordingSegments).mockImplementation(async (_cameraId, range) => {
      if (!range) return { available: true, segments: [], service_reachable: true };
      return {
        available: true,
        segments: [
          { start: '2026-09-05T07:58:00.000Z', duration: 60, url: 'https://playback.example/get?token=before-gap' },
          { start: '2026-09-05T08:10:00.000Z', duration: 60, url: 'https://playback.example/get?token=after-gap' },
        ],
        service_reachable: true,
      };
    });

    render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const slider = screen.getByLabelText('Scrub recorded footage timeline');
    seekTo(slider, 300, 600); // 08:05:00 -- falls in the gap between both returned segments
    fireEvent.click(screen.getByText('Play from here'));

    await waitFor(() => {
      expect(screen.getByText('No recorded footage at this exact time.')).toBeInTheDocument();
    });
    expect(document.querySelector('video')).toBeNull();
  });

  it('renders a marker for a confirmed detection and jumps playback there when clicked', async () => {
    vi.mocked(detectionService.search).mockResolvedValue([
      { id: 1, plate_number: 'GJ01AB1234', camera_id: 7, detected_at: '2026-09-05T08:05:00.000Z', confidence: 0.9 },
    ]);

    render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const marker = await screen.findByLabelText(/Jump to detection: GJ01AB1234/);
    fireEvent.click(marker);

    // SEGMENTS[0] starts 08:00:00; 08:05:00 is 300s in.
    expect(screen.getByLabelText('Scrub recorded footage timeline')).toHaveAttribute('aria-valuenow', '300');
  });

  it('steps the video forward and backward one frame via the frame-step buttons', async () => {
    render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const video = await waitFor(() => {
      const el = document.querySelector('video');
      expect(el).toHaveAttribute('src', SEGMENTS[0].url);
      return el as HTMLVideoElement;
    });

    video.currentTime = 10;
    fireEvent.click(screen.getByLabelText('Step forward one frame'));
    expect(video.currentTime).toBeCloseTo(10 + 1 / 25, 5);

    fireEvent.click(screen.getByLabelText('Step back one frame'));
    expect(video.currentTime).toBeCloseTo(10, 5);
  });

  it('automatically continues into the next window when playback reaches the end, instead of stopping', async () => {
    render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const video = await waitFor(() => {
      const el = document.querySelector('video');
      expect(el).toHaveAttribute('src', SEGMENTS[0].url);
      return el as HTMLVideoElement;
    });

    fireEvent.ended(video);

    // PLAYBACK_WINDOW_SECONDS / 2 = 150s past where this window started.
    await waitFor(() => {
      expect(screen.getByLabelText('Scrub recorded footage timeline')).toHaveAttribute('aria-valuenow', '150');
    });
    expect(document.querySelector('video')).toHaveAttribute('autoplay');
  });

  it("resets the scrubber when a different day's segments are passed in", () => {
    const { rerender } = render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const slider = screen.getByLabelText('Scrub recorded footage timeline');
    seekTo(slider, 400, 600);
    expect(slider).toHaveAttribute('aria-valuenow', '400');

    rerender(
      <RecordingPlayer
        cameraId={7}
        cameraName="Ring Road Camera"
        segments={[{ start: '2026-09-06T08:00:00.000Z', duration: 300, url: 'https://playback.example/get?token=next-day' }]}
      />
    );
    expect(screen.getByLabelText('Scrub recorded footage timeline')).toHaveAttribute('aria-valuenow', '0');
  });

  describe('drag-to-zoom and hover timestamp', () => {
    it('drag-selecting a range on the timeline zooms into it', () => {
      render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
      const track = screen.getByLabelText('Scrub recorded footage timeline');

      // Drag from 100s (clientX 50) to 200s (clientX 100) of a 600s/300px track.
      firePointerEvent(track, 'pointerdown', 50);
      firePointerEvent(track, 'pointermove', 100);
      firePointerEvent(track, 'pointerup', 100);

      expect(track).toHaveAttribute('aria-valuemin', '100');
      expect(track).toHaveAttribute('aria-valuemax', '200');
      expect(screen.getByText('Zoom out')).toBeInTheDocument();
    });

    it('a short drag under the zoom threshold is treated as a click-to-seek, not a zoom', () => {
      render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
      const track = screen.getByLabelText('Scrub recorded footage timeline');

      firePointerEvent(track, 'pointerdown', 50);
      firePointerEvent(track, 'pointermove', 52); // 2px -- under the 5px drag threshold
      firePointerEvent(track, 'pointerup', 52);

      expect(track).toHaveAttribute('aria-valuemin', '0');
      expect(track).toHaveAttribute('aria-valuemax', '600');
      expect(screen.queryByText('Zoom out')).not.toBeInTheDocument();
    });

    it('double-clicking the timeline pops one level of zoom', () => {
      render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
      const track = screen.getByLabelText('Scrub recorded footage timeline');

      firePointerEvent(track, 'pointerdown', 50);
      firePointerEvent(track, 'pointermove', 100);
      firePointerEvent(track, 'pointerup', 100);
      expect(track).toHaveAttribute('aria-valuemax', '200');

      fireEvent.doubleClick(track);
      expect(track).toHaveAttribute('aria-valuemax', '600');
    });

    it('the breadcrumb "Full range" control clears every zoom level at once', () => {
      render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
      const track = screen.getByLabelText('Scrub recorded footage timeline');

      firePointerEvent(track, 'pointerdown', 50);
      firePointerEvent(track, 'pointermove', 100);
      firePointerEvent(track, 'pointerup', 100);
      expect(track).toHaveAttribute('aria-valuemax', '200');

      fireEvent.click(screen.getByText('Full range'));
      expect(track).toHaveAttribute('aria-valuemax', '600');
    });

    it('Escape pops one level of zoom via the keyboard', () => {
      render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
      const track = screen.getByLabelText('Scrub recorded footage timeline');

      firePointerEvent(track, 'pointerdown', 50);
      firePointerEvent(track, 'pointermove', 100);
      firePointerEvent(track, 'pointerup', 100);
      expect(track).toHaveAttribute('aria-valuemax', '200');

      fireEvent.keyDown(track, { key: 'Escape' });
      expect(track).toHaveAttribute('aria-valuemax', '600');
    });

    it('arrow keys nudge the playhead within the visible range, keeping the timeline keyboard-operable', () => {
      render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
      const track = screen.getByLabelText('Scrub recorded footage timeline');

      fireEvent.keyDown(track, { key: 'ArrowRight' });
      expect(track).toHaveAttribute('aria-valuenow', '1');

      fireEvent.keyDown(track, { key: 'ArrowRight', shiftKey: true });
      expect(track).toHaveAttribute('aria-valuenow', '11');

      fireEvent.keyDown(track, { key: 'ArrowLeft' });
      expect(track).toHaveAttribute('aria-valuenow', '10');

      fireEvent.keyDown(track, { key: 'End' });
      expect(track).toHaveAttribute('aria-valuenow', '600');

      fireEvent.keyDown(track, { key: 'Home' });
      expect(track).toHaveAttribute('aria-valuenow', '0');
    });

    it('hovering over the timeline shows a timestamp tooltip that disappears on leave', () => {
      render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
      const track = screen.getByLabelText('Scrub recorded footage timeline');

      expect(screen.queryByTestId('timeline-hover-tooltip')).not.toBeInTheDocument();

      firePointerEvent(track, 'pointermove', 150);
      expect(screen.getByTestId('timeline-hover-tooltip')).toBeInTheDocument();

      firePointerEvent(track, 'pointerleave', 150);
      expect(screen.queryByTestId('timeline-hover-tooltip')).not.toBeInTheDocument();
    });
  });
});
