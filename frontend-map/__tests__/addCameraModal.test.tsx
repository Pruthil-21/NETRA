import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AddCameraModal from '@/components/registry/AddCameraModal';
import { areasService } from '@/services/areasService';
import { federationService } from '@/services/federationService';

vi.mock('@/services/areasService', () => ({
  areasService: { listAreas: vi.fn() },
}));
vi.mock('@/services/federationService', () => ({
  federationService: { listAllCameras: vi.fn() },
}));
vi.mock('@/services/cameraService', () => ({
  cameraService: { testStream: vi.fn() },
}));

const addCamera = vi.fn();
vi.mock('@/context/CameraRegistryContext', () => ({
  useCameraRegistry: () => ({ addCamera, importCameras: vi.fn() }),
}));

beforeEach(() => {
  addCamera.mockClear();
  (federationService.listAllCameras as any).mockResolvedValue([]);
});

// The area field is a type-to-search picker (same pattern as the Map page's
// area filter), not a native <select> -- its rows only render once the
// field is focused open.
async function selectArea(label: string) {
  fireEvent.focus(screen.getByLabelText('Area'));
  fireEvent.click(await screen.findByText(label));
}

describe('AddCameraModal area picker', () => {
  it('shows an Area search field populated from areasService once focused', async () => {
    (areasService.listAreas as any).mockResolvedValue([
      { id: 1, name: 'APC Area', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
    ]);
    render(<AddCameraModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Area')).toBeInTheDocument());
    fireEvent.focus(screen.getByLabelText('Area'));
    expect(await screen.findByText('Anand — APC Area')).toBeInTheDocument();
  });

  it('filters areas by district or name as you type', async () => {
    (areasService.listAreas as any).mockResolvedValue([
      { id: 1, name: 'APC Area', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
      { id: 2, name: 'Junagadh Area', district: 'Junagadh', created_at: '2026-01-01T00:00:00Z' },
    ]);
    render(<AddCameraModal onClose={() => {}} />);
    fireEvent.focus(screen.getByLabelText('Area'));
    expect(await screen.findByText('Anand — APC Area')).toBeInTheDocument();
    expect(screen.getByText('Junagadh — Junagadh Area')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'Junagadh' } });
    expect(screen.queryByText('Anand — APC Area')).not.toBeInTheDocument();
    expect(screen.getByText('Junagadh — Junagadh Area')).toBeInTheDocument();
  });

  it('shows the picked area in the field and closes the dropdown', async () => {
    (areasService.listAreas as any).mockResolvedValue([
      { id: 1, name: 'APC Area', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
    ]);
    render(<AddCameraModal onClose={() => {}} />);
    await selectArea('Anand — APC Area');
    expect(screen.getByLabelText('Area')).toHaveValue('Anand — APC Area');
    expect(screen.queryByText('Anand — APC Area', { selector: 'button' })).not.toBeInTheDocument();
  });
});

describe('AddCameraModal validation', () => {
  it('blocks submitting without an area and never calls addCamera', async () => {
    (areasService.listAreas as any).mockResolvedValue([
      { id: 1, name: 'APC Area', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
    ]);
    render(<AddCameraModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Area')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /add camera/i }));
    expect(await screen.findByText(/select an area for this camera before saving/i)).toBeInTheDocument();
    expect(addCamera).not.toHaveBeenCalled();
  });

  it('accepts submission once an area is selected', async () => {
    (areasService.listAreas as any).mockResolvedValue([
      { id: 1, name: 'APC Area', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
    ]);
    render(<AddCameraModal onClose={() => {}} />);
    await selectArea('Anand — APC Area');

    fireEvent.click(screen.getByRole('button', { name: /add camera/i }));
    await waitFor(() => expect(addCamera).toHaveBeenCalledWith(expect.objectContaining({ areaId: 1 })));
  });
});

describe('AddCameraModal video feed address', () => {
  beforeEach(() => {
    (areasService.listAreas as any).mockResolvedValue([
      { id: 1, name: 'APC Area', district: 'Anand', created_at: '2026-01-01T00:00:00Z' },
    ]);
  });

  const openStreamingSection = async () => {
    render(<AddCameraModal onClose={() => {}} />);
    await selectArea('Anand — APC Area');
    fireEvent.click(screen.getByText('Streaming Connection'));
  };

  it('treats a pasted https:// link as the HLS URL, not a stream_path', async () => {
    await openStreamingSection();
    fireEvent.change(screen.getByLabelText('Video Feed Address'), {
      target: { value: 'https://relay.example.com/stream/12/index.m3u8' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add camera/i }));
    await waitFor(() =>
      expect(addCamera).toHaveBeenCalledWith(
        expect.objectContaining({ hls_url: 'https://relay.example.com/stream/12/index.m3u8', stream_path: undefined })
      )
    );
  });

  it('treats a short pasted value as the stream_path, not an HLS URL', async () => {
    await openStreamingSection();
    fireEvent.change(screen.getByLabelText('Video Feed Address'), { target: { value: 'xiaomi-camera' } });
    fireEvent.click(screen.getByRole('button', { name: /add camera/i }));
    await waitFor(() =>
      expect(addCamera).toHaveBeenCalledWith(expect.objectContaining({ stream_path: 'xiaomi-camera', hls_url: undefined }))
    );
  });

  it('clears the video address entirely when "Add now, connect later" is chosen', async () => {
    await openStreamingSection();
    fireEvent.change(screen.getByLabelText('Video Feed Address'), { target: { value: 'xiaomi-camera' } });
    fireEvent.click(screen.getByRole('button', { name: /add now, connect later/i }));
    fireEvent.click(screen.getByRole('button', { name: /add camera/i }));
    await waitFor(() =>
      expect(addCamera).toHaveBeenCalledWith(expect.objectContaining({ stream_path: undefined, hls_url: undefined }))
    );
  });
});
