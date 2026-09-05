import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RecordingPlayer } from '@/components/archive/RecordingPlayer';

const SEGMENTS = [{ start: '2026-09-05T08:00:00.000Z', duration: 600 }];

describe('RecordingPlayer', () => {
  it('shows a quiet message when given no segments', () => {
    render(<RecordingPlayer pathId="7" cameraName="Ring Road Camera" segments={[]} />);
    expect(screen.getByText('No recorded footage for this day.')).toBeInTheDocument();
  });

  it('loads the player at the start of the given segments', () => {
    render(<RecordingPlayer pathId="7" cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const slider = screen.getByLabelText('Scrub recorded footage timeline');
    expect(slider).toHaveValue('0');
  });

  it('lets an officer scrub, mark a clip range, and export it', async () => {
    render(<RecordingPlayer pathId="7" cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const slider = screen.getByLabelText('Scrub recorded footage timeline');

    fireEvent.change(slider, { target: { value: '100' } });
    fireEvent.click(screen.getByText('Mark clip start'));
    fireEvent.change(slider, { target: { value: '400' } });
    fireEvent.click(screen.getByText('Mark clip end'));

    expect(await screen.findByText(/Clip range: 5m 0s/)).toBeInTheDocument();
    const exportLink = screen.getByText('Export Clip').closest('a');
    expect(exportLink).toHaveAttribute('href', expect.stringContaining('start=2026-09-05T08%3A01%3A40'));
    expect(exportLink).toHaveAttribute('href', expect.stringContaining('duration=300'));
  });

  it('resets the scrubber when a different day\'s segments are passed in', () => {
    const { rerender } = render(<RecordingPlayer pathId="7" cameraName="Ring Road Camera" segments={SEGMENTS} />);
    const slider = screen.getByLabelText('Scrub recorded footage timeline');
    fireEvent.change(slider, { target: { value: '400' } });
    expect(slider).toHaveValue('400');

    rerender(
      <RecordingPlayer
        pathId="7"
        cameraName="Ring Road Camera"
        segments={[{ start: '2026-09-06T08:00:00.000Z', duration: 300 }]}
      />
    );
    expect(screen.getByLabelText('Scrub recorded footage timeline')).toHaveValue('0');
  });
});
