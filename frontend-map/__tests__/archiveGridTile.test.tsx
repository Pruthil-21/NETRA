import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ArchiveGridTile } from '@/components/archive/ArchiveGridTile';
import { fetchRecordingSegments } from '@/services/recordingsService';
import { Camera } from '@/types/camera';

vi.mock('@/services/recordingsService', async () => {
  const actual = await vi.importActual<typeof import('@/services/recordingsService')>('@/services/recordingsService');
  return { ...actual, fetchRecordingSegments: vi.fn() };
});

const CAMERA: Camera = {
  id: 7,
  name: 'Ring Road Camera',
  dept: 'Ahmedabad',
  lat: 23.0,
  long: 72.5,
  camera_type: 'Bullet',
  ownership: 'test',
  connectivity_status: 'online',
  storage_type: 'Cloud',
  retention_days: 30,
  health_status: 'operational',
  rtsp_url: 'rtsp://localhost:8554/cam7',
};

describe('ArchiveGridTile', () => {
  beforeEach(() => {
    vi.mocked(fetchRecordingSegments).mockReset();
  });

  it("fetches and shows the camera's own day of footage independently", async () => {
    vi.mocked(fetchRecordingSegments).mockResolvedValue({
      available: true,
      segments: [{ start: '2026-09-05T08:00:00.000Z', duration: 600, url: 'https://playback.example/get?token=x' }],
    });

    render(<ArchiveGridTile camera={CAMERA} onRemove={vi.fn()} />);

    expect(screen.getByText('Ring Road Camera')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Scrub recorded footage timeline')).toBeInTheDocument());
    expect(fetchRecordingSegments).toHaveBeenCalledWith(7, expect.objectContaining({ start: expect.any(String), end: expect.any(String) }));
  });

  it('calls onRemove with the camera id when the remove button is clicked', () => {
    vi.mocked(fetchRecordingSegments).mockResolvedValue({ available: false, segments: [] });
    const onRemove = vi.fn();
    render(<ArchiveGridTile camera={CAMERA} onRemove={onRemove} />);

    fireEvent.click(screen.getByLabelText('Remove Ring Road Camera from the grid'));
    expect(onRemove).toHaveBeenCalledWith(7);
  });

  it('refetches when the day picker changes', async () => {
    vi.mocked(fetchRecordingSegments).mockResolvedValue({ available: false, segments: [] });
    render(<ArchiveGridTile camera={CAMERA} onRemove={vi.fn()} />);

    await waitFor(() => expect(fetchRecordingSegments).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Pick a day for Ring Road Camera'), { target: { value: '2026-08-01' } });
    await waitFor(() => expect(fetchRecordingSegments).toHaveBeenCalledTimes(2));
  });
});
