import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RecordingPlayer } from '@/components/archive/RecordingPlayer';
import { fetchRecordingSegments } from '@/services/recordingsService';

vi.mock('@/services/recordingsService', async () => {
  const actual = await vi.importActual<typeof import('@/services/recordingsService')>('@/services/recordingsService');
  return { ...actual, fetchRecordingSegments: vi.fn() };
});

const SEGMENTS = [
  { start: '2026-09-05T08:00:00.000Z', duration: 600, url: 'https://playback.example/get?token=day-segment' },
];

describe('RecordingPlayer', () => {
  beforeEach(() => {
    vi.mocked(fetchRecordingSegments).mockReset();
  });

  it('shows a quiet message when given no segments', () => {
    render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={[]} />);
    expect(screen.getByText('No recorded footage for this day.')).toBeInTheDocument();
  });

  it('loads the player at the start of the given segments', () => {
    render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const slider = screen.getByLabelText('Scrub recorded footage timeline');
    expect(slider).toHaveValue('0');
    const video = document.querySelector('video');
    expect(video).toHaveAttribute('src', SEGMENTS[0].url);
  });

  it('lets an officer scrub, mark a clip range, and export it', async () => {
    vi.mocked(fetchRecordingSegments).mockResolvedValue({
      available: true,
      segments: [{ start: '2026-09-05T08:01:40.000Z', duration: 300, url: 'https://playback.example/get?token=clip' }],
    });

    render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const slider = screen.getByLabelText('Scrub recorded footage timeline');

    fireEvent.change(slider, { target: { value: '100' } });
    fireEvent.click(screen.getByText('Mark clip start'));
    fireEvent.change(slider, { target: { value: '400' } });
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
    vi.mocked(fetchRecordingSegments).mockResolvedValue({ available: false, segments: [] });

    render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const slider = screen.getByLabelText('Scrub recorded footage timeline');

    fireEvent.change(slider, { target: { value: '100' } });
    fireEvent.click(screen.getByText('Mark clip start'));
    fireEvent.change(slider, { target: { value: '400' } });
    fireEvent.click(screen.getByText('Mark clip end'));

    await waitFor(() => {
      expect(screen.getByText('No continuous footage available in that exact range.')).toBeInTheDocument();
    });
    expect(screen.queryByText('Export Clip')).not.toBeInTheDocument();
  });

  it("resets the scrubber when a different day's segments are passed in", () => {
    const { rerender } = render(<RecordingPlayer cameraId={7} cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const slider = screen.getByLabelText('Scrub recorded footage timeline');
    fireEvent.change(slider, { target: { value: '400' } });
    expect(slider).toHaveValue('400');

    rerender(
      <RecordingPlayer
        cameraId={7}
        cameraName="Ring Road Camera"
        segments={[{ start: '2026-09-06T08:00:00.000Z', duration: 300, url: 'https://playback.example/get?token=next-day' }]}
      />
    );
    expect(screen.getByLabelText('Scrub recorded footage timeline')).toHaveValue('0');
  });
});
