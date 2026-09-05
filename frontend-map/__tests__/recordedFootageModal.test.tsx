import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RecordedFootageModal from '@/components/registry/RecordedFootageModal';
import { fetchRecordingSegments } from '@/services/recordingsService';
import { Camera } from '@/types/camera';

vi.mock('@/services/recordingsService');

const CAMERA: Camera = {
  id: 7,
  name: 'Ring Road Camera',
  dept: 'Traffic Police',
  lat: 23.0,
  long: 72.5,
  camera_type: 'IP',
  ownership: 'Traffic Police',
  connectivity_status: 'online',
  storage_type: 'Cloud',
  retention_days: 30,
  health_status: 'operational',
  rtsp_url: '',
  stream_id: '7',
};

describe('RecordedFootageModal', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('shows a quiet empty state when there are no recordings yet', async () => {
    (fetchRecordingSegments as any).mockResolvedValue({ available: false, segments: [] });
    render(<RecordedFootageModal camera={CAMERA} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No recorded footage available/)).toBeInTheDocument());
  });

  it('loads the player at the latest point and lets an officer scrub, mark a clip range, and export it', async () => {
    (fetchRecordingSegments as any).mockResolvedValue({
      available: true,
      segments: [{ start: '2026-09-05T08:00:00.000Z', duration: 600 }],
    });
    render(<RecordedFootageModal camera={CAMERA} onClose={() => {}} />);

    const slider = await screen.findByLabelText('Scrub recorded footage timeline');
    expect(slider).toHaveValue('600');

    fireEvent.change(slider, { target: { value: '100' } });
    fireEvent.click(screen.getByText('Mark clip start'));
    fireEvent.change(slider, { target: { value: '400' } });
    fireEvent.click(screen.getByText('Mark clip end'));

    expect(await screen.findByText(/Clip range: 5m 0s/)).toBeInTheDocument();
    const exportLink = screen.getByText('Export Clip').closest('a');
    expect(exportLink).toHaveAttribute('href', expect.stringContaining('start=2026-09-05T08%3A01%3A40'));
    expect(exportLink).toHaveAttribute('href', expect.stringContaining('duration=300'));
  });

  it('closes when the backdrop is clicked', async () => {
    (fetchRecordingSegments as any).mockResolvedValue({ available: false, segments: [] });
    const onClose = vi.fn();
    const { container } = render(<RecordedFootageModal camera={CAMERA} onClose={onClose} />);
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });
});
